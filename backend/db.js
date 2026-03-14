const { Pool } = require('pg');
const path = require('path');

// Database configuration - uses same setup as speech-practice
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/bank_to_ynab'
});

// Test connection
pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

async function initDb() {
  try {
    const client = await pool.connect();
    console.log('✅ PostgreSQL connected');
    client.release();
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    throw err;
  }
}

// === Mappings ===

async function getMappings() {
  const result = await pool.query('SELECT * FROM mappings ORDER BY keyword');
  const mappings = {};
  result.rows.forEach(row => {
    mappings[row.keyword.toLowerCase()] = {
      id: row.id,
      ynabCategoryId: row.ynab_category_id,
      ynabCategoryName: row.ynab_category_name
    };
  });
  return mappings;
}

async function getMappingsList() {
  const result = await pool.query(`
    SELECT m.*, COUNT(p.id) as payee_count 
    FROM mappings m 
    LEFT JOIN payees p ON p.mapping_id = m.id 
    GROUP BY m.id 
    ORDER BY m.keyword
  `);
  return result.rows;
}

async function createMapping(keyword, ynabCategoryId, ynabCategoryName) {
  const result = await pool.query(
    `INSERT INTO mappings (keyword, ynab_category_id, ynab_category_name) 
     VALUES ($1, $2, $3) 
     ON CONFLICT (keyword) 
     DO UPDATE SET ynab_category_id = $2, ynab_category_name = $3 
     RETURNING *`,
    [keyword.toLowerCase(), ynabCategoryId, ynabCategoryName]
  );
  return result.rows[0];
}

async function updateMapping(id, ynabCategoryId, ynabCategoryName) {
  const result = await pool.query(
    `UPDATE mappings 
     SET ynab_category_id = $1, ynab_category_name = $2 
     WHERE id = $3 
     RETURNING *`,
    [ynabCategoryId, ynabCategoryName, id]
  );
  return result.rows[0];
}

async function deleteMapping(id) {
  await pool.query('DELETE FROM mappings WHERE id = $1', [id]);
}

// === Payees ===

async function getOrCreatePayee(name, normalizedName) {
  // Try to find existing payee
  let result = await pool.query(
    'SELECT * FROM payees WHERE normalized_name = $1',
    [normalizedName.toLowerCase()]
  );
  
  if (result.rows.length > 0) {
    // Update last seen and count
    await pool.query(
      `UPDATE payees 
       SET transaction_count = transaction_count + 1, 
           last_seen_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [result.rows[0].id]
    );
    // Return updated payee
    result = await pool.query('SELECT * FROM payees WHERE id = $1', [result.rows[0].id]);
    return result.rows[0];
  }
  
  // Create new payee
  result = await pool.query(
    `INSERT INTO payees (name, normalized_name) 
     VALUES ($1, $2) 
     RETURNING *`,
    [name, normalizedName.toLowerCase()]
  );
  return result.rows[0];
}

async function getPayeesWithoutMapping() {
  const result = await pool.query(`
    SELECT p.* 
    FROM payees p 
    WHERE p.mapping_id IS NULL 
    ORDER BY p.transaction_count DESC, p.last_seen_at DESC
  `);
  return result.rows;
}

async function getPayeesWithMapping() {
  const result = await pool.query(`
    SELECT p.*, m.keyword, m.ynab_category_id, m.ynab_category_name
    FROM payees p
    JOIN mappings m ON m.id = p.mapping_id
    ORDER BY p.transaction_count DESC
  `);
  return result.rows;
}

async function updatePayeeMapping(payeeId, mappingId) {
  await pool.query(
    'UPDATE payees SET mapping_id = $1 WHERE id = $2',
    [mappingId, payeeId]
  );
}

async function findPayeesByKeyword(keyword) {
  const result = await pool.query(
    `SELECT * FROM payees 
     WHERE normalized_name ILIKE $1 
     ORDER BY transaction_count DESC`,
    [`%${keyword.toLowerCase()}%`]
  );
  return result.rows;
}

// === Transactions ===

async function createTransaction(payeeId, bookingDate, operationDate, amount, rawData, categoryId = null) {
  const result = await pool.query(
    `INSERT INTO transactions 
     (payee_id, booking_date, operation_date, amount, raw_data, category_id) 
     VALUES ($1, $2, $3, $4, $5, $6) 
     RETURNING *`,
    [payeeId, bookingDate, operationDate, amount, JSON.stringify(rawData), categoryId]
  );
  return result.rows[0];
}

async function getRecentTransactions(limit = 100) {
  const result = await pool.query(`
    SELECT t.*, p.name as payee_name, p.normalized_name,
           m.ynab_category_id, m.ynab_category_name
    FROM transactions t
    JOIN payees p ON p.id = t.payee_id
    LEFT JOIN mappings m ON m.id = p.mapping_id
    ORDER BY t.booking_date DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

async function clearOldTransactions(days = 30) {
  await pool.query(
    `DELETE FROM transactions 
     WHERE imported_at < CURRENT_TIMESTAMP - INTERVAL '${days} days'`
  );
}

// === Auto-categorization ===

async function autoCategorizeTransactions() {
  // Get all payees that don't have a mapping
  const payeesResult = await pool.query(`
    SELECT p.id, p.normalized_name 
    FROM payees p 
    WHERE p.mapping_id IS NULL
  `);
  
  const mappings = await getMappings();
  const categorized = [];
  
  for (const payee of payeesResult.rows) {
    const payeeName = payee.normalized_name.toLowerCase();
    
    // Find matching keyword
    for (const [keyword, mapping] of Object.entries(mappings)) {
      if (payeeName.includes(keyword.toLowerCase())) {
        // Update payee with mapping
        await pool.query(
          'UPDATE payees SET mapping_id = $1 WHERE id = $2',
          [mapping.id, payee.id]
        );
        categorized.push({
          payeeId: payee.id,
          keyword: keyword,
          categoryName: mapping.ynabCategoryName
        });
        break;
      }
    }
  }
  
  return categorized;
}

async function getTransactionsWithCategories() {
  const result = await pool.query(`
    SELECT 
      t.id,
      t.booking_date as date,
      t.amount,
      p.name as payee,
      COALESCE(m.ynab_category_id, t.category_id) as category_id,
      COALESCE(m.ynab_category_name, 'Uncategorized') as category_name
    FROM transactions t
    JOIN payees p ON p.id = t.payee_id
    LEFT JOIN mappings m ON m.id = p.mapping_id
    WHERE t.exported_to_ynab = false
    ORDER BY t.booking_date DESC
  `);
  return result.rows;
}

module.exports = {
  pool,
  initDb,
  getMappings,
  getMappingsList,
  createMapping,
  updateMapping,
  deleteMapping,
  getOrCreatePayee,
  getPayeesWithoutMapping,
  getPayeesWithMapping,
  updatePayeeMapping,
  findPayeesByKeyword,
  createTransaction,
  getRecentTransactions,
  clearOldTransactions,
  autoCategorizeTransactions,
  getTransactionsWithCategories
};
