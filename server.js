import express from 'express';
import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';
import multer from 'multer';
import pool, { initDb } from './db.js';
import { parse } from 'csv-parse/sync';
import jwt from 'jsonwebtoken';
import admin from 'firebase-admin';

// Initialize Firebase Admin only when explicit credentials are provided.
// Avoid calling `admin.initializeApp()` without credentials to prevent
// accidental attempts to contact Google Cloud (which can cause errors
// like "Unable to detect a Project Id in the current environment").
let firebaseAdmin = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    firebaseAdmin = admin.initializeApp({ credential: admin.credential.cert(svc) });
    console.log('Firebase Admin initialized using service account');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // If a path to a service account file is explicitly provided via
    // GOOGLE_APPLICATION_CREDENTIALS, allow default initialization.
    firebaseAdmin = admin.initializeApp();
    console.log('Firebase Admin initialized using GOOGLE_APPLICATION_CREDENTIALS');
  } else {
    console.log('Skipping Firebase Admin initialization (no credentials provided)');
    firebaseAdmin = null;
  }
} catch (e) {
  console.warn('Firebase Admin initialization failed, token verification will be best-effort:', e.message);
  firebaseAdmin = null;
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

let userId = 1;

// middleware: verify firebase id token if provided and attach auth user id
app.use(async (req, res, next) => {
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (!auth) return next();
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (!m) return next();
  const idToken = m[1];
  let payload = null;
  try {
    if (firebaseAdmin) {
      const decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
      payload = decoded;
    } else {
      // best-effort decode (NOT VERIFIED) to extract uid/email when admin SDK not configured
      payload = jwt.decode(idToken) || {};
      console.warn('Decoded Firebase token without verification; set FIREBASE_SERVICE_ACCOUNT_JSON for secure verification');
    }
  } catch (e) {
    console.warn('Firebase token verify failed:', e.message);
    // try decode anyway
    payload = jwt.decode(idToken) || {};
  }

  // extract uid/email/name from token payload
  const uid = payload.uid || payload.user_id || payload.sub;
  const email = payload.email || null;
  const name = payload.name || payload.displayName || null;

  // attach raw firebase uid for downstream Firestore usage
  if (uid) req.firebaseUid = uid;

  if (!uid) return next();

  try {
    // lookup user by firebase_uid or email
    const [[existing]] = await pool.query('SELECT * FROM users WHERE firebase_uid = ? LIMIT 1', [uid]);
    if (existing) {
        req.authUserId = existing.id;
      } else if (email) {
      const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
      if (rows.length) {
        // attach firebase_uid for future
        await pool.query('UPDATE users SET firebase_uid = ? WHERE id = ?', [uid, rows[0].id]);
        req.authUserId = rows[0].id;
      } else {
        // create a new user linked to firebase uid
        const [r] = await pool.query('INSERT INTO users (email, password, shop_name, firebase_uid) VALUES (?, ?, ?, ?)', [email || '', '', name || 'Shop', uid]);
        req.authUserId = r.insertId;
      }
    } else {
      // create user only with firebase uid
      const [r] = await pool.query('INSERT INTO users (email, password, shop_name, firebase_uid) VALUES (?, ?, ?, ?)', ['', '', name || 'Shop', uid]);
      req.authUserId = r.insertId;
    }
  } catch (dbErr) {
    console.warn('Error mapping firebase user to DB user:', dbErr.message);
  }

  return next();
});

const getUserId = (req) => {
  if (req.authUserId) return req.authUserId;
  const h = req.headers['x-user-id'];
  const q = req.query?.user_id;
  return h ? parseInt(h) : (q ? parseInt(q) : userId);
};

// expose firebase uid for Firestore-based storage
app.use((req, res, next) => {
  if (req.authUserId && typeof req.authUserId === 'string') {
    req.firebaseUid = req.authUserId;
  }
  next();
});

const firestore = firebaseAdmin ? firebaseAdmin.firestore() : null;

app.get('/', (req, res) => res.send('<html><body><h1>Smart Billing API Server</h1><p>Backend is running on port ' + PORT + '</p></body></html>'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const subExpired = user.subscription_expiry && new Date(user.subscription_expiry) < new Date();
    res.json({ user: { ...user, subscriptionActive: !subExpired } });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, shop_name } = req.body;
    const [r] = await pool.query('INSERT INTO users (email, password, shop_name) VALUES (?, ?, ?)', [email, password || 'demo123', shop_name || 'My Shop']);
    userId = r.insertId;
    res.json({ id: r.insertId, message: 'Registered' });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const uid = getUserId(req);
    const [[totalRev]] = await pool.query('SELECT COALESCE(SUM(total_amount), 0) as v FROM bills WHERE user_id = ?', [uid]);
    const [[todayRev]] = await pool.query('SELECT COALESCE(SUM(total_amount), 0) as v FROM bills WHERE user_id = ? AND DATE(created_at) = CURDATE()', [uid]);
    const [[totalBills]] = await pool.query('SELECT COUNT(*) as v FROM bills WHERE user_id = ?', [uid]);
    const [[pending]] = await pool.query('SELECT COALESCE(SUM(pending_amount), 0) as v FROM bills WHERE user_id = ?', [uid]);
    
    // STEP 1: Calculate billing profit from billed items (KEEP EXISTING LOGIC UNCHANGED)
    // Profit per billed item: (sale_price - cost_price) * qty
    let billingProfitAmount = 0;
    try {
      const [rows] = await pool.query(`
        SELECT bi.quantity as qty, bi.unit_price as sale_price, b.created_at as bill_date, i.cost_price as cost_price, i.expiry_date as expiry_date
        FROM bill_items bi
        JOIN bills b ON bi.bill_id = b.id
        LEFT JOIN items i ON bi.item_id = i.id
        WHERE b.user_id = ?
      `, [uid]);

      for (const r of rows) {
        const qty = parseInt(r.qty) || 0;
        const sale = parseFloat(r.sale_price) || 0;
        const cost = parseFloat(r.cost_price) || 0;
        // For billed items: always calculate as (sale - cost) * qty (don't apply expiry loss to already-billed items)
        billingProfitAmount += ((sale - cost) * qty);
      }
      billingProfitAmount = Math.round(billingProfitAmount * 100) / 100;
    } catch (calcErr) {
      console.warn('Billing profit calculation failed, defaulting to 0:', calcErr.message || calcErr);
      billingProfitAmount = 0;
    }

    // STEP 2: Calculate expiry loss from unsold expired items in inventory
    // For each expired item: loss = (quantity * cost_price) or cost_price if qty=0
   // STEP 2 FINAL — PERMANENT EXPIRY LOSS (NEVER RECOVER)
let expiryLossAmount = 0;

try {

  // 1️⃣ Detect expired items (only once store permanent loss)
  const [expiredItems] = await pool.query(`
    SELECT id,item_name,quantity,cost_price,expiry_date
    FROM items
    WHERE user_id = ?
    AND expiry_date IS NOT NULL
    AND DATE(expiry_date) <= CURDATE()
  `,[uid]);

  for (const item of expiredItems){

    // already stored or not check
    const [[exists]] = await pool.query(`
      SELECT id FROM expiry_loss_history
      WHERE item_id=? AND user_id=?
    `,[item.id,uid]);

    if(!exists){

      const qty = Number(item.quantity) || 0;
      const cost = Number(item.cost_price) || 0;

      // 🔥 FIX: only qty * cost
      // qty = 0 → NO LOSS
      let loss = 0;

      if(qty > 0){
        loss = qty * cost;
      } else {
        loss = 0; // ❌ do NOT take cost_price if qty=0
      }

      // only store if loss > 0
      if(loss > 0){
        await pool.query(`
          INSERT INTO expiry_loss_history
          (user_id,item_id,item_name,loss_amount)
          VALUES(?,?,?,?)
        `,[uid,item.id,item.item_name,loss]);

        console.log("LOSS STORED:",item.item_name,loss);
      }
    }
  }

  // 2️⃣ Sum permanent loss
  const [[row]] = await pool.query(`
    SELECT COALESCE(SUM(loss_amount),0) as total
    FROM expiry_loss_history
    WHERE user_id=?
  `,[uid]);

  expiryLossAmount = Number(row.total) || 0;

  console.log("TOTAL PERMANENT LOSS:",expiryLossAmount);

}catch(err){
  console.log("Expiry loss error:",err);
  expiryLossAmount = 0;
}

    // STEP 3: Calculate final profit = billing profit - expiry loss
    const profitAmount = Math.round((billingProfitAmount - expiryLossAmount) * 100) / 100;

    res.json({ totalRevenue: totalRev.v, todayRevenue: todayRev.v, totalBills: totalBills.v, pendingAmount: pending.v, profitAmount });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/dashboard/revenue-graph', async (req, res) => {
  try {
    const uid = getUserId(req);
    const [rows] = await pool.query(`SELECT DATE(created_at) as date, SUM(total_amount) as amount FROM bills WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY DATE(created_at) ORDER BY date`, [uid]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/dashboard/top-items', async (req, res) => {
  try {
    const uid = getUserId(req);
    const [rows] = await pool.query(`SELECT bi.item_name, SUM(bi.quantity) as qty, SUM(bi.total) as total FROM bill_items bi JOIN bills b ON bi.bill_id = b.id WHERE b.user_id = ? AND b.created_at >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH) GROUP BY bi.item_name ORDER BY qty DESC LIMIT 10`, [uid]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/items', async (req, res) => {
  try {
    const { search, page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Use MySQL for items (do not depend on Firestore)
    const uid = getUserId(req);
    let where = 'user_id = ? OR user_id IS NULL';
    const params = [uid];
    if (search) {
      where += ' AND (item_code LIKE ? OR item_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    const [[count]] = await pool.query(`SELECT COUNT(*) as c FROM items WHERE ${where}`, params);
    const [rows] = await pool.query(`SELECT * FROM items WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]);
    const [[sum]] = await pool.query(`SELECT COALESCE(SUM(item_price * quantity), 0) as s FROM items WHERE ${where}`, params);
    res.json({ items: rows, total: count.c, totalPrice: sum.s });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.post('/api/items', async (req, res) => {
  try {
    const { item_code, item_name, quantity = 0, item_price = 0, gst = 0, uom = 'PCS', cost_price = 0, mrp = 0, expiry_date = null } = req.body;
    
    // Validate required fields
    if (!item_code || !item_code.trim()) {
      return res.status(400).json({ success: false, error: 'Item code is required' });
    }
    if (!item_name || !item_name.trim()) {
      return res.status(400).json({ success: false, error: 'Item name is required' });
    }
    
    // Validate numeric fields
    const qty = parseInt(quantity) || 0;
    const price = parseFloat(item_price) || 0;
    const gstVal = parseFloat(gst) || 0;
    const costVal = parseFloat(cost_price) || 0;
    const mrpVal = parseFloat(mrp) || 0;
    
    if (qty < 0) {
      return res.status(400).json({ success: false, error: 'Quantity cannot be negative' });
    }
    if (price < 0) {
      return res.status(400).json({ success: false, error: 'Price cannot be negative' });
    }
    if (gstVal < 0 || gstVal > 100) {
      return res.status(400).json({ success: false, error: 'GST must be between 0 and 100' });
    }
    
    const uid = getUserId(req);
    const [r] = await pool.query('INSERT INTO items (item_code, item_name, quantity, item_price, gst, uom, user_id, cost_price, mrp, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item_code.trim(), item_name.trim(), qty, price, gstVal, uom || 'PCS', uid, costVal, mrpVal, expiry_date || null]);
    
    // Create history entry for new item
    if (qty > 0) {
      await pool.query('INSERT INTO item_updates_history (user_id, item_id, item_code, item_name, sale_price, available_qty, updated_qty, difference, action_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [uid, r.insertId, item_code.trim(), item_name.trim(), price, 0, qty, qty, 'Added']);
    }
    
    res.json({ success: true, message: `${item_name || 'Item'} saved successfully`, itemName: item_name || '', id: r.insertId });
  } catch (e) {
    console.error('POST /api/items error:', e);
    const errorMsg = e.code === 'ER_DUP_ENTRY' ? 'Item code already exists' : String(e?.message || e?.code || e);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

app.put('/api/items/:id', async (req, res) => {
  try {
    if (process.env.DEBUG_ITEMS) console.log('PUT /api/items/:id body:', req.body, 'headers:', { 'x-user-id': req.headers['x-user-id'] });
    const { item_code, item_name, quantity, item_price, gst, uom, cost_price = 0, mrp = 0, expiry_date = null } = req.body;
    const uid = getUserId(req);
    const itemId = req.params.id;
    
    // Validate required fields
    if (!item_code || !item_code.trim()) {
      return res.status(400).json({ error: 'Item code is required' });
    }
    if (!item_name || !item_name.trim()) {
      return res.status(400).json({ error: 'Item name is required' });
    }
    
    // Validate numeric fields
    const qty = parseInt(quantity) || 0;
    const price = parseFloat(item_price) || 0;
    const gstVal = parseFloat(gst) || 0;
    const costVal = parseFloat(cost_price) || 0;
    const mrpVal = parseFloat(mrp) || 0;
    
    if (qty < 0) {
      return res.status(400).json({ error: 'Quantity cannot be negative' });
    }
    if (price < 0) {
      return res.status(400).json({ error: 'Price cannot be negative' });
    }
    if (gstVal < 0 || gstVal > 100) {
      return res.status(400).json({ error: 'GST must be between 0 and 100' });
    }
    
    // Get old item details for history tracking
    const [oldItems] = await pool.query('SELECT quantity, item_code, item_name FROM items WHERE id = ? AND user_id = ?', [itemId, uid]);
    if (!oldItems || oldItems.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    const oldQty = oldItems[0].quantity;
    const newQty = qty;
    const difference = newQty - oldQty;
    
    // Only create history entry if quantity changed
    if (difference !== 0) {
      const actionType = difference > 0 ? 'Added' : 'Reduced';
      await pool.query('INSERT INTO item_updates_history (user_id, item_id, item_code, item_name, sale_price, available_qty, updated_qty, difference, action_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [uid, itemId, item_code.trim(), item_name.trim(), price, oldQty, newQty, Math.abs(difference), actionType]);
    }
    
    await pool.query('UPDATE items SET item_code=?, item_name=?, quantity=?, item_price=?, gst=?, uom=?, cost_price=?, mrp=?, expiry_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [item_code.trim(), item_name.trim(), qty, price, gstVal, uom || 'PCS', costVal, mrpVal, expiry_date || null, itemId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/items/:id error:', e);
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM items WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.post('/api/items/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'No ids' });
    await pool.query('DELETE FROM items WHERE id IN (?)', [ids]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.post('/api/items/import', upload.single('file'), async (req, res) => {
  try {
    const records = parse(req.file.buffer, { columns: true, skip_empty_lines: true });
    const uid = getUserId(req);
    let importCount = 0;
    const errors = [];
    
    for (let idx = 0; idx < records.length; idx++) {
      const r = records[idx];
      const code = r.item_code || r.Item_Code;
      if (!code) {
        errors.push(`Row ${idx + 1}: Item code is required`);
        continue;
      }
      
      const qty = parseInt(r.quantity || r.Quantity || 0) || 0;
      const price = parseFloat(r.item_price || r.Item_Price || 0) || 0;
      const gstVal = parseFloat(r.gst || r.GST || 0) || 0;
      const costVal = parseFloat(r.cost_price || r.Cost_Price || 0) || 0;
      const mrpVal = parseFloat(r.mrp || r.MRP || 0) || 0;
      const expiryDate = r.expiry_date || r.Expiry_Date || null;
      
      // Validate numeric values
      if (qty < 0) {
        errors.push(`Row ${idx + 1}: Quantity cannot be negative`);
        continue;
      }
      if (price < 0) {
        errors.push(`Row ${idx + 1}: Price cannot be negative`);
        continue;
      }
      if (gstVal < 0 || gstVal > 100) {
        errors.push(`Row ${idx + 1}: GST must be between 0 and 100`);
        continue;
      }
      
      const uom = r.uom || r.UOM || r.UoM || 'PCS';
      const itemName = r.item_name || r.Item_Name || '';
      try {
        // Check if item already exists
        const [existingItems] = await pool.query('SELECT id, quantity FROM items WHERE item_code = ? AND user_id = ?', [code, uid]);
        
        if (existingItems.length > 0) {
          // Item exists - update and track history
          const oldQty = existingItems[0].quantity;
          const newQty = qty;
          const difference = newQty - oldQty;
          
          if (difference !== 0) {
            await pool.query('INSERT INTO item_updates_history (user_id, item_id, item_code, item_name, sale_price, available_qty, updated_qty, difference, action_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [uid, existingItems[0].id, code, itemName, price, oldQty, newQty, Math.abs(difference), 'Imported']);
          }
          
          await pool.query('UPDATE items SET item_name=?, quantity=?, item_price=?, gst=?, uom=?, cost_price=?, mrp=?, expiry_date=?, updated_at=CURRENT_TIMESTAMP WHERE item_code = ? AND user_id = ?', [itemName, newQty, price, gstVal, uom, costVal, mrpVal, expiryDate, code, uid]);
        } else {
          // New item - insert and track history
          const [insertResult] = await pool.query('INSERT INTO items (item_code, item_name, quantity, item_price, gst, uom, user_id, cost_price, mrp, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [code, itemName, qty, price, gstVal, uom, uid, costVal, mrpVal, expiryDate]);
          
          if (qty > 0) {
            await pool.query('INSERT INTO item_updates_history (user_id, item_id, item_code, item_name, sale_price, available_qty, updated_qty, difference, action_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [uid, insertResult.insertId, code, itemName, price, 0, qty, qty, 'Imported']);
          }
        }
        
        importCount++;
      } catch (e) {
        errors.push(`Row ${idx + 1}: ${e.message}`);
      }
    }
    
    const response = { imported: importCount, total: records.length };
    if (errors.length > 0) {
      response.errors = errors.slice(0, 10); // Return first 10 errors
      response.errorCount = errors.length;
    }
    res.json(response);
  } catch (e) {
    console.error('POST /api/items/import error:', e);
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/items/export', async (req, res) => {
  try {
    const uid = getUserId(req);
    const [rows] = await pool.query('SELECT item_code, item_name, uom, quantity, item_price, gst FROM items WHERE user_id = ? OR user_id IS NULL ORDER BY id DESC', [uid]);
    
    const headers = ['Item Code', 'Item Name', 'UOM', 'Quantity', 'Item Price', 'GST'];
    const csvRows = rows.map(r => {
      const cells = [
        String(r.item_code || ''),
        String(r.item_name || ''),
        String(r.uom || 'PCS'),
        String(r.quantity || 0),
        String(r.item_price || 0),
        String(r.gst || 0)
      ];
      return cells.map(cell => {
        if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
          return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
      }).join(',');
    });
    
    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="items_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('GET /api/items/export error:', e);
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/items/search', async (req, res) => {
  try {
    const { q } = req.query;
    const uid = getUserId(req);
    const [rows] = await pool.query('SELECT * FROM items WHERE (user_id = ? OR user_id IS NULL) AND (item_code LIKE ? OR item_name LIKE ?) LIMIT 20', [uid, `%${q || ''}%`, `%${q || ''}%`]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.post('/api/bills', async (req, res) => {
  try {
    const { customer_name, customer_mobile, items } = req.body;
    
    // Validate required fields
    if (!customer_name || !customer_name.trim()) {
      return res.status(400).json({ error: 'Customer name is required' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }
    
    const bill_number = 'BL' + Date.now();
    let total = 0;
    
    // Validate items and calculate total
    for (const i of items) {
      const qty = parseInt(i.quantity) || 0;
      const price = parseFloat(i.unit_price) || 0;
      const gst = parseFloat(i.gst) || 0;
      
      // Validate item data
      if (qty <= 0) {
        return res.status(400).json({ error: 'Item quantity must be greater than 0' });
      }
      if (price < 0) {
        return res.status(400).json({ error: 'Item price cannot be negative' });
      }
      if (gst < 0 || gst > 100) {
        return res.status(400).json({ error: 'GST must be between 0 and 100' });
      }
      
      total += price * qty * (1 + gst / 100);
    }
    
    if (total <= 0) {
      return res.status(400).json({ error: 'Bill total must be greater than 0' });
    }
    
    if (req.firebaseUid && firestore) {
      const ref = firestore.collection('users').doc(req.firebaseUid).collection('bills');
      const data = { bill_number, customer_name, customer_mobile, total_amount: Number(total), pending_amount: 0, items, created_at: new Date().toISOString() };
      const r = await ref.add(data);
      return res.json({ id: r.id, bill_number, total });
    }
    
    const uid = getUserId(req);
    const [r] = await pool.query('INSERT INTO bills (bill_number, customer_name, customer_mobile, total_amount, pending_amount, user_id) VALUES (?, ?, ?, ?, ?, ?)', [bill_number, customer_name, customer_mobile, total, 0, uid]);
    const billId = r.insertId;
    
    // Add bill items and decrement stock
    for (const i of items) {
      const qty = parseInt(i.quantity) || 1;
      const price = parseFloat(i.unit_price) || 0;
      const gst = parseFloat(i.gst) || 0;
      const itemTotal = price * qty * (1 + gst / 100);
      const uom = i.uom || i.UOM || null;
      
      await pool.query('INSERT INTO bill_items (bill_id, item_id, item_name, quantity, unit_price, gst, total, uom) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [billId, i.item_id, i.item_name, qty, price, gst, itemTotal, uom]);
      
      // Decrement item stock
      if (i.item_id) {
        await pool.query('UPDATE items SET quantity = GREATEST(0, quantity - ?) WHERE id = ?', [qty, i.item_id]);
      }
    }
    
    res.json({ id: billId, bill_number, total });
  } catch (e) {
    console.error('POST /api/bills error:', e);
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/bills', async (req, res) => {
  try {
    const { search, start_date, end_date } = req.query;
    if (req.firebaseUid && firestore) {
      const ref = firestore.collection('users').doc(req.firebaseUid).collection('bills');
      const snap = await ref.get();
      let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (search) {
        const q = String(search).toLowerCase();
        rows = rows.filter(r => (r.bill_number || '').toLowerCase().includes(q) || (r.customer_name || '').toLowerCase().includes(q) || (r.customer_mobile || '').toLowerCase().includes(q));
      }
      if (start_date) rows = rows.filter(r => new Date(r.created_at) >= new Date(start_date));
      if (end_date) rows = rows.filter(r => new Date(r.created_at) <= new Date(end_date));
      rows = rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return res.json(rows);
    }
    const uid = getUserId(req);
    const { search: s, start_date: sd, end_date: ed } = req.query;
    let where = 'user_id = ?';
    const params = [uid];
    if (s) {
      where += ' AND (bill_number LIKE ? OR customer_name LIKE ? OR customer_mobile LIKE ?)';
      params.push(`%${s}%`, `%${s}%`, `%${s}%`);
    }
    if (sd) { where += ' AND DATE(created_at) >= ?'; params.push(sd); }
    if (ed) { where += ' AND DATE(created_at) <= ?'; params.push(ed); }
    const [rows] = await pool.query(`SELECT * FROM bills WHERE ${where} ORDER BY created_at DESC`, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/bills/export', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { search, start_date, end_date } = req.query;
    let where = 'user_id = ?';
    const params = [uid];
    if (search) {
      where += ' AND (bill_number LIKE ? OR customer_name LIKE ? OR customer_mobile LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (start_date) { where += ' AND DATE(created_at) >= ?'; params.push(start_date); }
    if (end_date) { where += ' AND DATE(created_at) <= ?'; params.push(end_date); }
    const [rows] = await pool.query(`SELECT * FROM bills WHERE ${where} ORDER BY created_at DESC`, params);
    
    const headers = ['bill_number', 'customer_name', 'customer_mobile', 'total_amount', 'pending_amount', 'created_at'];
    const csvRows = rows.map(r => headers.map(h => {
      let v = r[h];
      if (v === null || v === undefined) v = '';
      // Properly escape CSV values
      if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) {
        return `"${String(v).replace(/"/g, '""')}"`;
      }
      return String(v);
    }).join(','));
    
    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bills_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('GET /api/bills/export error:', e);
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/bills/:id', async (req, res) => {
  try {
    if (req.firebaseUid && firestore) {
      const doc = await firestore.collection('users').doc(req.firebaseUid).collection('bills').doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: doc.id, ...doc.data() });
    }
    const [bills] = await pool.query('SELECT * FROM bills WHERE id = ?', [req.params.id]);
    const [items] = await pool.query('SELECT * FROM bill_items WHERE bill_id = ?', [req.params.id]);
    if (!bills.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...bills[0], items });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { search, start_date, end_date } = req.query;
    let where = 'user_id = ?';
    const params = [uid];
    if (search) {
      where += ' AND (item_code LIKE ? OR item_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (start_date) { where += ' AND DATE(created_at) >= ?'; params.push(start_date); }
    if (end_date) { where += ' AND DATE(created_at) <= ?'; params.push(end_date); }
    const [rows] = await pool.query(`SELECT * FROM items WHERE ${where} ORDER BY created_at DESC`, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/reports/items-history', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { search, start_date, end_date, page = 1, limit = 10 } = req.query;
    let where = 'user_id = ?';
    const params = [uid];
    if (search) {
      where += ' AND (item_code LIKE ? OR item_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (start_date) { where += ' AND DATE(created_at) >= ?'; params.push(start_date); }
    if (end_date) { where += ' AND DATE(created_at) <= ?'; params.push(end_date); }
    
    // Get total count
    const [[countResult]] = await pool.query(`SELECT COUNT(*) as total FROM item_updates_history WHERE ${where}`, params);
    const total = countResult.total;
    
    // Get paginated data
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit) || 10));
    const offset = (pageNum - 1) * limitNum;
    
    const [rows] = await pool.query(
      `SELECT id, user_id, item_id, item_code, item_name, sale_price, available_qty, updated_qty, difference, action_type, created_at FROM item_updates_history WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );
    
    res.json({
      data: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/reports/items-export', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { search, start_date, end_date } = req.query;
    let where = 'user_id = ?';
    const params = [uid];
    if (search) {
      where += ' AND (item_code LIKE ? OR item_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (start_date) { where += ' AND DATE(created_at) >= ?'; params.push(start_date); }
    if (end_date) { where += ' AND DATE(created_at) <= ?'; params.push(end_date); }
    
    const [rows] = await pool.query(
      `SELECT item_code, item_name, sale_price, available_qty, updated_qty, difference, action_type, created_at 
       FROM item_updates_history WHERE ${where} ORDER BY created_at DESC`,
      params
    );
    
    const headers = ['Item Code', 'Item Name', 'Sale Price', 'Available QTY', 'Updated QTY', 'Difference', 'Action Type', 'Date & Time'];
    const csvRows = rows.map(r => [
      r.item_code || '',
      r.item_name || '',
      r.sale_price || '0',
      r.available_qty || '0',
      r.updated_qty || '0',
      r.difference || '0',
      r.action_type || '',
      new Date(r.created_at).toLocaleString('en-IN')
    ].map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','));
    
    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reports.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/reports/export', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { search, start_date, end_date } = req.query;
    let where = 'user_id = ?';
    const params = [uid];
    if (search) {
      where += ' AND (item_code LIKE ? OR item_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (start_date) { where += ' AND DATE(created_at) >= ?'; params.push(start_date); }
    if (end_date) { where += ' AND DATE(created_at) <= ?'; params.push(end_date); }
    const [rows] = await pool.query(`SELECT item_code, item_name, quantity, item_price, gst, uom, created_at FROM items WHERE ${where} ORDER BY created_at DESC`, params);
    const csv = 'Item Code,Item Name,Quantity,Price,GST,UOM,Updated At\n' + rows.map(r => `"${r.item_code}","${r.item_name}",${r.quantity},${r.item_price},${r.gst},"${r.uom}",${r.created_at}`).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="items_export_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e?.code || e) });
  }
});

app.get('/api/customer-details', async (req, res) => {
  try {
    if (req.firebaseUid && firestore) {
      const doc = await firestore.collection('users').doc(req.firebaseUid).collection('meta').doc('customer_details').get();
      return res.json(doc.exists ? doc.data() : { name: '', organization_name: '', email: '', address: '', gstin: '' });
    }
    const uid = getUserId(req);
    try {
      const [rows] = await pool.query('SELECT * FROM customer_details WHERE user_id = ? LIMIT 1', [uid]);
      if (rows && rows.length > 0) {
        return res.json(rows[0]);
      }
    } catch (tableError) {
      console.warn('customer_details table may not exist:', tableError.message);
    }
    res.json({ name: '', organization_name: '', email: '', address: '', gstin: '' });
  } catch (e) {
    console.error('GET /api/customer-details error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/customer-details', async (req, res) => {
  try {
    const { name, organization_name, email, address, gstin } = req.body;
    if (req.firebaseUid && firestore) {
      const ref = firestore.collection('users').doc(req.firebaseUid).collection('meta').doc('customer_details');
      await ref.set({ name: name || '', organization_name: organization_name || '', email: email || '', address: address || '', gstin: gstin || '' }, { merge: true });
      return res.json({ success: true, message: 'Customer saved successfully' });
    }
    const uid = getUserId(req);
    await pool.query('INSERT INTO customer_details (user_id, name, organization_name, email, address, gstin) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), organization_name=VALUES(organization_name), email=VALUES(email), address=VALUES(address), gstin=VALUES(gstin)', [uid, name || '', organization_name || '', email || '', address || '', gstin || '']);
    res.json({ success: true, message: 'Customer saved successfully' });
  } catch (e) {
    console.error('POST /api/customer-details error:', e);
    res.status(500).json({ success: false, error: String(e?.message || e?.code || e) });
  }
});

// Global error handler (format errors as JSON)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: String(err?.message || err) });
});

app.post('/api/subscription/recharge', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { plan_months, amount } = req.body;
    const [user] = await pool.query('SELECT subscription_expiry FROM users WHERE id = ?', [uid]);
    let base = new Date();
    if (user[0]?.subscription_expiry && new Date(user[0].subscription_expiry) > base) base = new Date(user[0].subscription_expiry);
    base.setMonth(base.getMonth() + plan_months);
    await pool.query('UPDATE users SET subscription_expiry = ? WHERE id = ?', [base.toISOString().split('T')[0], uid]);
    await pool.query('INSERT INTO subscriptions (user_id, plan_months, amount) VALUES (?, ?, ?)', [uid, plan_months, amount]);
    res.json({ ok: true, expiry: base.toISOString().split('T')[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

try {
  await initDb();
  console.log('Database initialization succeeded');
} catch (e) {
  console.warn('Database initialization failed, continuing without DB. Errors will be returned on DB calls:', e.message || e);
}

// Start server with retry on EADDRINUSE to avoid failing when port is busy
const startServer = (port, attempts = 5) => {
  const server = app.listen(port);
  server.on('listening', () => console.log(`Server on ${port}`));
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attempts > 0) {
      console.warn(`Port ${port} in use, retrying on port ${port + 1}...`);
      setTimeout(() => startServer(port + 1, attempts - 1), 200);
      return;
    }
    console.error('Server failed to start:', err);
    process.exit(1);
  });
};

startServer(Number(PORT) || 5000);
