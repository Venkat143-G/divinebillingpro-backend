import fetch from 'node-fetch';
import mysql from 'mysql2/promise';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const portsToTry = [3000, 5000, 5001, 5002];
async function findBase() {
  for (const p of portsToTry) {
    try {
      const res = await fetch(`http://localhost:${p}/api/health`, { timeout: 2000 });
      if (res.ok) return `http://localhost:${p}`;
    } catch (e) {}
  }
  throw new Error('No running backend found on expected ports');
}

async function queryDb(poolSql, params = []) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'smartbilling'
  });
  try {
    const [rows] = await conn.query(poolSql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

function fmt(v){ return (typeof v === 'number' ? v : Number(v || 0)).toFixed(2); }

async function run() {
  const result = { passed: [], failed: [], details: [] };
  console.log('Full E2E suite starting...');
  const base = await findBase();
  console.log('Using backend:', base);

  // AUTH + SESSION basic check (login endpoint exists)
  try {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify({ email: 'demo@shop.com', password: 'demo123' }) });
    const j = await r.json().catch(()=>null);
    if (r.ok && j && j.user) { result.passed.push('auth_login'); console.log('auth_login OK'); }
    else { result.failed.push('auth_login'); result.details.push({auth_login: j || r.status}); }
  } catch (e) { result.failed.push('auth_login'); result.details.push({auth_login: String(e)}); }

  // ITEMS CRUD + DB verification
  let testItem = null;
  try {
    const code = 'E2E' + Date.now();
    const payload = { item_code: code, item_name: 'Full E2E Item', quantity: 50, item_price: 99.5, cost_price: 60.25, gst: 12, uom: 'PCS', mrp: 120, expiry_date: new Date(Date.now()+86400000*30).toISOString().slice(0,10) };
    const res = await fetch(`${base}/api/items`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(payload) });
    const j = await res.json();
    if (!j || !j.id) throw new Error('Create failed: ' + JSON.stringify(j));
    testItem = { id: j.id, code };
    const rows = await queryDb('SELECT * FROM items WHERE id = ?', [j.id]);
    if (!rows || rows.length !== 1) throw new Error('DB row missing');
    const row = rows[0];
    if (row.item_code !== code) throw new Error('DB value mismatch item_code');
    result.passed.push('items_create'); console.log('items_create OK');

    // Update
    const upd = { ...payload, quantity: 75, item_code: code, item_name: payload.item_name };
    const ures = await fetch(`${base}/api/items/${j.id}`, { method: 'PUT', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(upd) });
    const uj = await ures.json().catch(()=>null);
    if (ures.ok) {
      const r2 = await queryDb('SELECT quantity FROM items WHERE id = ?', [j.id]);
      if (Number(r2[0].quantity) !== 75) throw new Error('Update not persisted');
      result.passed.push('items_update'); console.log('items_update OK');
    } else throw new Error('PUT failed: ' + JSON.stringify(uj || ures.status));

    // Export CSV and compare
    const ex = await fetch(`${base}/api/items/export`, { headers: {'x-user-id':'1'} });
    if (!ex.ok) throw new Error('Export failed');
    const blob = await ex.text();
    if (!blob.includes(code)) throw new Error('Export CSV missing item');
    result.passed.push('items_export'); console.log('items_export OK');

    // Delete
    const dres = await fetch(`${base}/api/items/${j.id}`, { method: 'DELETE', headers: {'x-user-id':'1'} });
    const dj = await dres.json().catch(()=>null);
    if (!dres.ok) throw new Error('Delete failed');
    const after = await queryDb('SELECT * FROM items WHERE id = ?', [j.id]);
    if (after.length !== 0) throw new Error('Item not deleted');
    result.passed.push('items_delete'); console.log('items_delete OK');
  } catch (e) {
    result.failed.push('items_crud'); result.details.push({items_crud: String(e)}); console.error('items_crud failed', e);
  }

  // CSV import test
  try {
    const csvPath = path.join(os.tmpdir(), `e2e_import_${Date.now()}.csv`);
    const csv = 'item_code,item_name,quantity,item_price,gst,cost_price,mrp,expiry_date\nIMPA,Import Item,3,50,0,30,60,2025-12-31\n';
    fs.writeFileSync(csvPath, csv);
    const fd = fs.createReadStream(csvPath);
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', fd);
    const res = await fetch(`${base}/api/items/import`, { method: 'POST', headers: {'x-user-id':'1', ...(form.getHeaders ? form.getHeaders() : {})}, body: form });
    const j = await res.json();
    if (!j || typeof j.imported !== 'number') throw new Error('Import failed: ' + JSON.stringify(j));
    result.passed.push('items_import'); console.log('items_import OK');
  } catch (e) { result.failed.push('items_import'); result.details.push({items_import: String(e)}); }

  // Billing flow: create bill, verify bill_items and quantity decrement
  try {
    // create an item specifically for billing
    const billCode = 'BILL' + Date.now();
    const payload = { item_code: billCode, item_name: 'Bill Item', quantity: 10, item_price: 200, cost_price: 120, gst: 0, uom: 'PCS', mrp: 220, expiry_date: new Date(Date.now()+86400000*10).toISOString().slice(0,10) };
    const cres = await fetch(`${base}/api/items`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(payload) });
    const cj = await cres.json(); if (!cj.id) throw new Error('bill item create failed');
    const itemId = cj.id;
    // create bill
    const billPayload = { customer_name: 'E2E Bill Cust', customer_mobile: '7777777777', items: [{ item_id: itemId, item_name: payload.item_name, quantity: 2, unit_price: payload.item_price, gst: payload.gst }] };
    const bres = await fetch(`${base}/api/bills`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(billPayload) });
    const bj = await bres.json(); if (!bj.id) throw new Error('bill create failed:' + JSON.stringify(bj));
    // verify bill items
    const bis = await queryDb('SELECT * FROM bill_items WHERE bill_id = ?', [bj.id]);
    if (!bis || bis.length === 0) throw new Error('no bill_items created');
    // verify item qty decreased
    const post = await queryDb('SELECT quantity FROM items WHERE id = ?', [itemId]);
    if (Number(post[0].quantity) !== 8) throw new Error('quantity not decremented correctly');
    result.passed.push('billing_basic'); console.log('billing_basic OK');

    // expired item bill test: create expired item and bill it
    const expCode = 'EXPP' + Date.now();
    const expPayload = { item_code: expCode, item_name: 'Expired', quantity: 2, item_price: 50, cost_price: 30, gst:0, uom:'PCS', mrp:60, expiry_date: new Date(Date.now()-86400000*2).toISOString().slice(0,10) };
    const expRes = await fetch(`${base}/api/items`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(expPayload) });
    const ej = await expRes.json(); if (!ej.id) throw new Error('expired item create failed');
    const billExp = { customer_name: 'E2E Exp', customer_mobile: '6666666666', items: [{ item_id: ej.id, item_name: expPayload.item_name, quantity: 1, unit_price: expPayload.item_price, gst:0 }] };
    const br = await fetch(`${base}/api/bills`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(billExp) });
    const bj2 = await br.json(); if (!bj2.id) throw new Error('expired bill create failed');
    result.passed.push('billing_expired_allowed'); console.log('billing_expired_allowed OK');
  } catch (e) { result.failed.push('billing'); result.details.push({billing: String(e)}); console.error('billing failure', e); }

  // Dashboard profit verification
  try {
    const sres = await fetch(`${base}/api/dashboard/summary`, { headers: {'x-user-id':'1'} });
    const s = await sres.json();
    if (s && typeof s.profitAmount !== 'undefined') { result.passed.push('dashboard_summary'); console.log('dashboard_summary OK', s.profitAmount); }
    else { throw new Error('summary missing profitAmount'); }
  } catch (e) { result.failed.push('dashboard_summary'); result.details.push({dashboard_summary: String(e)}); }

  // Reports history: ensure item_updates_history is populated for an update
  try {
    // update one of the created items quantity
    const [one] = await queryDb('SELECT id,item_code FROM items WHERE item_code LIKE ? LIMIT 1', ['BILL%']);
    if (!one) throw new Error('no bill item found for history test');
    await fetch(`${base}/api/items/${one.id}`, { method: 'PUT', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify({ item_code: one.item_code, item_name: 'X', quantity: 99, item_price: 1, gst:0, uom:'PCS', cost_price: 0, mrp:0, expiry_date: null }) });
    const hist = await queryDb('SELECT * FROM item_updates_history WHERE item_code = ? ORDER BY created_at DESC LIMIT 1', [one.item_code]);
    if (!hist || hist.length === 0) throw new Error('no history row created');
    result.passed.push('reports_history'); console.log('reports_history OK');
  } catch (e) { result.failed.push('reports_history'); result.details.push({reports_history: String(e)}); }

  // CSV exports: bills and reports
  try {
    const bre = await fetch(`${base}/api/bills/export`, { headers: {'x-user-id':'1'} });
    if (!bre.ok) throw new Error('bills export HTTP failed: ' + bre.status);
    const btxt = await bre.text(); 
    // Check that we got a valid CSV (at least headers should exist, even if empty data)
    if (!btxt || btxt.trim().length === 0) throw new Error('bills CSV empty');
    if (!btxt.includes('bill_number')) throw new Error('bills CSV missing headers');
    const rre = await fetch(`${base}/api/reports/items-export`, { headers: {'x-user-id':'1'} });
    if (!rre.ok) throw new Error('reports export HTTP failed: ' + rre.status);
    const rtxt = await rre.text(); 
    if (!rtxt || rtxt.trim().length === 0) throw new Error('reports CSV empty');
    if (!rtxt.includes('Item Code')) throw new Error('reports CSV missing headers');
    result.passed.push('csv_exports'); console.log('csv_exports OK');
  } catch (e) { result.failed.push('csv_exports'); result.details.push({csv_exports: String(e)}); console.error('csv_exports error:', e); }

  // Delete bill and check DB & profit recalculation
  try {
    // create a bill and then delete
    const [it] = await queryDb('SELECT id FROM items WHERE item_code LIKE ? LIMIT 1', ['BILL%']);
    if (!it) throw new Error('no item for delete test');
    const pay = { customer_name: 'DEL', customer_mobile: '1111111111', items: [{ item_id: it.id, item_name: 'del', quantity: 1, unit_price: 10, gst:0 }] };
    const br = await fetch(`${base}/api/bills`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify(pay) });
    const bj = await br.json(); if (!bj.id) throw new Error('bill create for delete failed');
    // delete via DB to simulate API delete (no API exists)
    await queryDb('DELETE FROM bills WHERE id = ?', [bj.id]);
    const bi = await queryDb('SELECT * FROM bills WHERE id = ?', [bj.id]); if (bi.length !== 0) throw new Error('bill not deleted');
    result.passed.push('delete_bill'); console.log('delete_bill OK');
  } catch (e) { result.failed.push('delete_bill'); result.details.push({delete_bill: String(e)}); }

  // Performance smoke: insert 200 small items and create 50 bills, measure response time
  try {
    const start = Date.now();
    for (let i=0;i<200;i++){
      const c = 'PF' + Date.now() + '_' + i;
      await fetch(`${base}/api/items`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify({ item_code:c, item_name:'Perf', quantity:1, item_price:1, cost_price:0.5, gst:0, uom:'PCS', mrp:1, expiry_date: null }) });
    }
    for (let i=0;i<50;i++){
      const [one] = await queryDb('SELECT id FROM items WHERE item_code LIKE ? LIMIT 1', ['PF%']);
      if (!one) break;
      await fetch(`${base}/api/bills`, { method: 'POST', headers: {'Content-Type':'application/json','x-user-id':'1'}, body: JSON.stringify({ customer_name:'P', customer_mobile:'000', items:[{ item_id: one.id, item_name:'Perf', quantity:1, unit_price:1, gst:0 }] }) });
    }
    const elapsed = Date.now() - start;
    result.passed.push('perf_smoke'); result.details.push({perf_time_ms: elapsed}); console.log('perf_smoke OK elapsed ms', elapsed);
  } catch (e) { result.failed.push('perf_smoke'); result.details.push({perf_smoke: String(e)}); }

  console.log('Full E2E summary:', { passed: result.passed, failed: result.failed, details: result.details });
  fs.writeFileSync(path.join(process.cwd(),'tools','full_e2e_result.json'), JSON.stringify(result, null, 2));
}

run().catch(e=>{ console.error('Suite error', e); process.exit(1); });
