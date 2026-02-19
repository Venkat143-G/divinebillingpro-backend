import pool from './db.js';
import dotenv from 'dotenv';

dotenv.config();

async function resetDatabase() {
  const conn = await pool.getConnection();
  try {
    console.log('🔄 Resetting database...');

    // Clear old data (keep the schema)
    await conn.query('DELETE FROM bill_items');
    console.log('✓ Cleared bill_items');

    await conn.query('DELETE FROM bills');
    console.log('✓ Cleared bills');

    await conn.query('DELETE FROM items');
    console.log('✓ Cleared items');

    await conn.query('DELETE FROM customer_details');
    console.log('✓ Cleared customer_details');

    // Keep demo user for testing
    await conn.query(`
      INSERT IGNORE INTO users (id, email, password, shop_name, subscription_expiry) 
      VALUES (1, 'demo@shop.com', 'demo123', 'Demo Medical Shop', DATE_ADD(CURDATE(), INTERVAL 30 DAY))
    `);
    console.log('✓ Demo user ready');

    console.log('\n✅ Database reset complete! Ready for fresh data.');
    console.log('📝 You can now:');
    console.log('   - Login with demo@shop.com / demo123');
    console.log('   - Add new items');
    console.log('   - Create fresh bills');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error resetting database:', err.message);
    process.exit(1);
  } finally {
    conn.release();
  }
}

resetDatabase();
