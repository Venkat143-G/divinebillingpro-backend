import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

(async ()=>{
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'smartbilling'
  });
  const [rows] = await conn.query("SELECT id,item_code,quantity,item_price,cost_price,updated_at FROM items WHERE item_code LIKE 'TST%';");
  console.log(rows);
  const [uids] = await conn.query("SELECT id,item_code,user_id FROM items WHERE item_code LIKE 'TST%';");
  console.log('User IDs for TST items:', uids);
  const [cols] = await conn.query("SHOW COLUMNS FROM items;");
  console.log('COLUMNS:');
  console.log(cols.map(c=>({Field:c.Field,Type:c.Type,Null:c.Null,Default:c.Default}))); 
  await conn.end();
})().catch(e=>{console.error(e);process.exit(1)})
