import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// Log connection details for debugging
const dbHost = process.env.DB_HOST || 'localhost';
const dbUser = process.env.DB_USER || 'root';
const dbPassword = process.env.DB_PASSWORD || '';
const dbName = process.env.DB_NAME || 'medical_billing';

console.log('📊 Database Configuration:');
console.log(`   Host: ${dbHost}`);
console.log(`   User: ${dbUser}`);
console.log(`   Password Length: ${dbPassword.length} chars`);
console.log(`   Password: ${dbPassword ? '***SET***' : '***EMPTY***'}`);
console.log(`   Database: ${dbName}`);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  ssl: {
    rejectUnauthorized: false
  }
});

export async function initDb() {
  try {
    // Test connection first
    console.log('🔍 Testing MySQL connection...');
    const testConn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      port: 3306
    });
    
    await testConn.ping();
    console.log('✅ MySQL Connected Successfully!');
    await testConn.end();
    
    // Create database if not exists
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      port: 3306
    });
    try {
      const dbName = process.env.DB_NAME || 'medical_billing';
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      console.log(`✅ Database '${dbName}' ready`);
    } finally {
      await conn.end();
    }

    const poolConn = await pool.getConnection();
    try {
    await poolConn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        shop_name VARCHAR(255),
        subscription_expiry DATE,
        firebase_uid VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await poolConn.query(`
      CREATE TABLE IF NOT EXISTS items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_code VARCHAR(50) UNIQUE NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        quantity INT DEFAULT 0,
        item_price DECIMAL(12,2) DEFAULT 0,
        gst DECIMAL(5,2) DEFAULT 0,
        uom VARCHAR(10) DEFAULT 'PCS',
        user_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    await poolConn.query(`
      CREATE TABLE IF NOT EXISTS bills (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bill_number VARCHAR(50) UNIQUE NOT NULL,
        customer_name VARCHAR(255),
        customer_mobile VARCHAR(20),
        total_amount DECIMAL(12,2) DEFAULT 0,
        pending_amount DECIMAL(12,2) DEFAULT 0,
        user_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    await poolConn.query(`
      CREATE TABLE IF NOT EXISTS bill_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bill_id INT NOT NULL,
        item_id INT NOT NULL,
        item_name VARCHAR(255),
        quantity INT DEFAULT 1,
        unit_price DECIMAL(12,2),
        gst DECIMAL(5,2),
        total DECIMAL(12,2),
        uom VARCHAR(10),
        FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES items(id)
      )
    `);
    await poolConn.query(`
      CREATE TABLE IF NOT EXISTS customer_details (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT UNIQUE,
        name VARCHAR(255),
        organization_name VARCHAR(255),
        email VARCHAR(255),
        address TEXT,
        gstin VARCHAR(50),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    await poolConn.query(`INSERT IGNORE INTO users (id, email, password, shop_name, subscription_expiry) VALUES (1, 'demo@shop.com', 'demo123', 'Demo Medical Shop', DATE_ADD(CURDATE(), INTERVAL 30 DAY))`);
    await poolConn.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        plan_months INT,
        amount DECIMAL(12,2),
        paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    await poolConn.query(`
      CREATE TABLE IF NOT EXISTS item_updates_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        item_id INT,
        item_code VARCHAR(50) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        sale_price DECIMAL(12,2) DEFAULT 0,
        available_qty INT DEFAULT 0,
        updated_qty INT DEFAULT 0,
        difference INT DEFAULT 0,
        action_type VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL,
        INDEX idx_user_id (user_id),
        INDEX idx_created_at (created_at),
        INDEX idx_item_code (item_code)
      )
    `);
    // ensure uom column exists on existing installations
    try {
      const dbName = process.env.DB_NAME || 'medical_billing';
      const [[itemsCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND COLUMN_NAME = 'uom'", [dbName]);
      if (!itemsCol.c) {
        await poolConn.query("ALTER TABLE items ADD COLUMN uom VARCHAR(10) DEFAULT 'PCS'");
      }
      const [[billItemsCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'bill_items' AND COLUMN_NAME = 'uom'", [dbName]);
      if (!billItemsCol.c) {
        await poolConn.query("ALTER TABLE bill_items ADD COLUMN uom VARCHAR(10)");
      }
      // Ensure cost_price and expiry_date exist on items table
      const [[costPriceCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND COLUMN_NAME = 'cost_price'", [dbName]);
      if (!costPriceCol.c) {
        await poolConn.query("ALTER TABLE items ADD COLUMN cost_price DECIMAL(12,2) DEFAULT 0");
        console.log('✓ Added cost_price column to items');
      } else {
        console.log('✓ cost_price column already exists');
      }

      // Ensure mrp column exists on items table
      try {
        const [[mrpCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND COLUMN_NAME = 'mrp'", [dbName]);
        if (!mrpCol.c) {
          await poolConn.query("ALTER TABLE items ADD COLUMN mrp DECIMAL(12,2) DEFAULT 0");
          console.log('✓ Added mrp column to items');
        } else {
          console.log('✓ mrp column already exists');
        }
      } catch (mrpErr) {
        console.warn('Could not add mrp column to items:', mrpErr.message || mrpErr);
      }

      const [[expiryCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND COLUMN_NAME = 'expiry_date'", [dbName]);
      if (!expiryCol.c) {
        await poolConn.query("ALTER TABLE items ADD COLUMN expiry_date DATE DEFAULT NULL");
        console.log('✓ Added expiry_date column to items');
      } else {
        console.log('✓ expiry_date column already exists');
      }
      // Ensure updated_at column exists on items table
      try {
        const [[updatedAtCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND COLUMN_NAME = 'updated_at'", [dbName]);
        if (!updatedAtCol.c) {
          await poolConn.query("ALTER TABLE items ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
          console.log('✓ Added updated_at column to items');
        } else {
          console.log('✓ updated_at column already exists');
        }
      } catch (uaErr) {
        console.warn('Could not add updated_at column to items:', uaErr.message || uaErr);
      }
      // Add organization_name, email, and address columns if they don't exist
    
    // Check and add organization_name column
    const [[orgNameCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer_details' AND COLUMN_NAME = 'organization_name'", [dbName]);
    if (!orgNameCol.c) {
      await poolConn.query("ALTER TABLE customer_details ADD COLUMN organization_name VARCHAR(255)");
      console.log('✓ Added organization_name column');
    } else {
      console.log('✓ organization_name column already exists');
    }
    
    // Check and add email column
    const [[emailCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer_details' AND COLUMN_NAME = 'email'", [dbName]);
    if (!emailCol.c) {
      await poolConn.query("ALTER TABLE customer_details ADD COLUMN email VARCHAR(255)");
      console.log('✓ Added email column');
    } else {
      console.log('✓ email column already exists');
    }
    
    // Check and add address column
    const [[addressCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer_details' AND COLUMN_NAME = 'address'", [dbName]);
    if (!addressCol.c) {
      await poolConn.query("ALTER TABLE customer_details ADD COLUMN address TEXT");
      console.log('✓ Added address column');
    } else {
      console.log('✓ address column already exists');
    }
    
    // Ensure sale_price column exists on item_updates_history table
    try {
      const [[salePriceCol]] = await poolConn.query("SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'item_updates_history' AND COLUMN_NAME = 'sale_price'", [dbName]);
      if (!salePriceCol.c) {
        await poolConn.query("ALTER TABLE item_updates_history ADD COLUMN sale_price DECIMAL(12,2) DEFAULT 0 AFTER item_name");
        console.log('✓ Added sale_price column to item_updates_history');
      } else {
        console.log('✓ sale_price column already exists in item_updates_history');
      }
    } catch (migrationErr) {
      console.warn('Could not add sale_price column to item_updates_history:', migrationErr.message || migrationErr);
    }
  } catch (err) {
      console.warn('Could not ensure uom columns exist:', err.message || err);
    }
    console.log('✅ Database initialized successfully');
  } finally {
    poolConn.release();
  }
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    console.error('   Error:', err.code);
    console.error('');
    console.error('   Troubleshooting:');
    console.error('   1. Verify MySQL service is running: Get-Service MySQL*');
    console.error('   2. Test credentials in MySQL Workbench');
    console.error('   3. Check .env file has correct password (no quotes around special chars)');
    console.error('   4. Ensure database host/port are correct in .env');
    console.error('   5. Check MySQL user exists and has permissions');
    console.error('');
    console.error('   Current credentials:');
    console.error(`   Host: ${dbHost}, User: ${dbUser}, DB: ${dbName}`);
    throw err;
  }
}

export default pool;
