import fetch from 'node-fetch';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const portsToTry = [3000, 5000, 5001, 5002];

async function findBase() {
  for (const p of portsToTry) {
    try {
      const res = await fetch(`http://localhost:${p}/api/health`, { timeout: 2000 });
      if (res.ok) return `http://localhost:${p}`;
    } catch (e) {
      // ignore
    }
  }
  throw new Error('No running backend found on expected ports');
}

async function queryDb(sql, params=[]) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'smartbilling'
  });
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

async function run() {
  console.log('E2E test starting...');
  const base = await findBase();
  console.log('Backend base URL:', base);

  // 1. Create a test item
  const code = 'TST' + Date.now();
  const itemPayload = {
    item_code: code,
    item_name: 'E2E Test Item',
    quantity: 10,
    item_price: 150.5,
    cost_price: 100.25,
    gst: 12,
    uom: 'PCS',
    mrp: 200,
    expiry_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString().slice(0,10)
  };
  console.log('Creating item', code);
  const createRes = await fetch(base + '/api/items', { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(itemPayload) });
  const createJson = await createRes.json();
  if (!createJson.success && !createJson.id) {
    console.error('Item create failed', createJson);
    process.exit(1);
  }
  const itemId = createJson.id || createJson.insertId || createJson.id;
  console.log('Item created id=', itemId);

  // 2. Verify in DB
  const items = await queryDb('SELECT * FROM items WHERE item_code = ?', [code]);
  if (items.length !== 1) {
    console.error('Item not found or multiple', items.length);
    process.exit(1);
  }
  console.log('DB item verified. qty=', items[0].quantity, 'cost_price=', items[0].cost_price);

  // 3. Update item quantity
  console.log('Updating item quantity to 20');
  const putRes = await fetch(base + `/api/items/${items[0].id}`, { method: 'PUT', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify({ ...itemPayload, quantity: 20, item_code: code, item_name: itemPayload.item_name }) });
  const putJson = await putRes.json().catch(() => null);
  console.log('PUT response:', putRes.status, putJson);
  const updated = await queryDb('SELECT * FROM items WHERE id = ?', [items[0].id]);
  console.log('Updated qty=', updated[0].quantity);
  if (Number(updated[0].quantity) !== 20) {
    console.error('Update did not persist'); process.exit(1);
  }

  // 4. Create a bill with this item (qty 2)
  console.log('Creating bill with qty 2 of item');
  const billPayload = { customer_name: 'E2E Cust', customer_mobile: '9999999999', items: [{ item_id: updated[0].id, item_name: updated[0].item_name, quantity: 2, unit_price: updated[0].item_price, gst: updated[0].gst }] };
  const billRes = await fetch(base + '/api/bills', { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(billPayload) });
  const billJson = await billRes.json();
  if (!billJson.id) { console.error('Bill create failed', billJson); process.exit(1); }
  console.log('Bill created id=', billJson.id, 'total=', billJson.total);

  // 5. Verify bill_items and items quantity decremented
  const billItems = await queryDb('SELECT * FROM bill_items WHERE bill_id = ?', [billJson.id]);
  console.log('bill_items rows=', billItems.length);
  if (billItems.length === 0) { console.error('No bill items'); process.exit(1); }
  const postItem = await queryDb('SELECT * FROM items WHERE id = ?', [updated[0].id]);
  console.log('Post-bill qty=', postItem[0].quantity);
  if (Number(postItem[0].quantity) !== 18) { console.error('Quantity not decremented correctly'); process.exit(1); }

  // 6. Check dashboard profit calculation API
  const summaryRes = await fetch(base + '/api/dashboard/summary', { headers: {'x-user-id':'1'} });
  const summary = await summaryRes.json();
  console.log('Dashboard summary:', summary);
  // compute expected profit for the bill: (sale - cost)*qty
  const expectedProfit = (parseFloat(updated[0].item_price) - parseFloat(updated[0].cost_price)) * 2;
  if (Math.abs(Number(summary.profitAmount) - expectedProfit) > 0.01) {
    console.error('Profit mismatch. expected', expectedProfit, 'got', summary.profitAmount);
    // not fatal here, but report
  } else {
    console.log('Profit OK for this bill');
  }

  // 7. Create expired item and bill to test expiry loss
  const code2 = 'TSTEXP' + Date.now();
  const expiredPayload = { item_code: code2, item_name: 'Expired Item', quantity: 5, item_price: 200, cost_price: 150, gst: 0, uom: 'PCS', mrp: 250, expiry_date: new Date(Date.now() - 1000*60*60*24*5).toISOString().slice(0,10) };
  const res2 = await fetch(base + '/api/items', { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(expiredPayload) });
  const j2 = await res2.json();
  const expId = j2.id;
  console.log('Expired item id=', expId);

  // Create bill with expired item qty 1
  const bill2 = { customer_name: 'E2E Cust2', customer_mobile: '8888888888', items: [{ item_id: expId, item_name: expiredPayload.item_name, quantity: 1, unit_price: expiredPayload.item_price, gst: 0 }] };
  const bill2res = await fetch(base + '/api/bills', { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(bill2) });
  const bill2json = await bill2res.json();
  console.log('Bill2 created', bill2json.id);

  // check dashboard profit now
  const summary2 = await (await fetch(base + '/api/dashboard/summary', { headers: {'x-user-id':'1'} })).json();
  console.log('Dashboard summary after expired bill:', summary2);
  // expected: previous profit + (sale-cost)*0 for expired? per rules expired subtract cost_price
  const expectedAfter = expectedProfit - expiredPayload.cost_price * 1;
  console.log('Expected approx profit after expired bill:', expectedAfter);

  // 8. Reports history test: update item quantity and check item_updates_history
  console.log('Testing reports (item_updates_history) on item update');
  // change quantity of first item to 25
  await fetch(base + `/api/items/${updated[0].id}`, { method: 'PUT', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify({ ...itemPayload, quantity: 25, item_code: code, item_name: itemPayload.item_name }) });
  const history = await queryDb('SELECT * FROM item_updates_history WHERE item_code = ? ORDER BY created_at DESC LIMIT 1', [code]);
  console.log('Latest history row:', history[0]);
  if (!history[0]) { console.error('No history row created'); }

  console.log('E2E test completed');
}

run().catch(err => { console.error('E2E test error:', err); process.exit(1); });
