const { Pool, types } = require('pg');
const path = require('path');

// Fix: pg by default parses DATE as local-time Date, which shifts dates by timezone offset.
// Return raw string (YYYY-MM-DD) to avoid timezone issues.
types.setTypeParser(1082, val => val);

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

    // Ensure screenshot review sessions table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS screenshot_review_sessions (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) UNIQUE NOT NULL,
        import_batch_id VARCHAR(255),
        data JSONB NOT NULL,
        status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_screenshot_sessions_session_id
      ON screenshot_review_sessions(session_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_screenshot_sessions_status
      ON screenshot_review_sessions(status)
    `);

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

async function getPayeeByNormalizedName(normalizedName) {
  const result = await pool.query(
    `SELECT p.*, m.ynab_category_id, m.ynab_category_name
     FROM payees p
     LEFT JOIN mappings m ON m.id = p.mapping_id
     WHERE p.normalized_name = $1`,
    [normalizedName.toLowerCase()]
  );
  return result.rows[0] || null;
}

async function findMappingForPayee(normalizedName) {
  const mappings = await getMappings();
  const payeeName = normalizedName.toLowerCase();
  for (const [keyword, mapping] of Object.entries(mappings)) {
    if (payeeName.includes(keyword.toLowerCase())) {
      return mapping;
    }
  }
  return null;
}

// === Screenshot Review Sessions ===

async function createScreenshotSession(sessionId, importBatchId, data) {
  const result = await pool.query(
    `INSERT INTO screenshot_review_sessions (session_id, import_batch_id, data)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [sessionId, importBatchId, JSON.stringify(data)]
  );
  return result.rows[0];
}

async function getScreenshotSession(sessionId) {
  const result = await pool.query(
    `SELECT * FROM screenshot_review_sessions
     WHERE session_id = $1 AND status = 'pending'`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function updateScreenshotSession(sessionId, data) {
  const result = await pool.query(
    `UPDATE screenshot_review_sessions
     SET data = $1, updated_at = CURRENT_TIMESTAMP
     WHERE session_id = $2 AND status = 'pending'
     RETURNING *`,
    [JSON.stringify(data), sessionId]
  );
  return result.rows[0] || null;
}

async function deleteScreenshotSession(sessionId) {
  await pool.query(
    `DELETE FROM screenshot_review_sessions WHERE session_id = $1`,
    [sessionId]
  );
}

async function markScreenshotSessionConfirmed(sessionId) {
  const result = await pool.query(
    `UPDATE screenshot_review_sessions
     SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP
     WHERE session_id = $1
     RETURNING *`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function getPendingScreenshotSessions(limit = 10) {
  const result = await pool.query(
    `SELECT * FROM screenshot_review_sessions
     WHERE status = 'pending'
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// === Transactions ===

async function createTransaction(payeeId, bookingDate, operationDate, amount, rawData, categoryId = null, importBatchId = null, sourceType = 'csv', originalAmount = null, originalCurrency = null, plnEquivalent = null) {
  // Named params support: if first argument is an object, unpack it.
  let params;
  if (payeeId && typeof payeeId === 'object') {
    params = payeeId;
  } else {
    params = {
      payeeId,
      bookingDate,
      operationDate,
      amount,
      rawData,
      categoryId,
      importBatchId,
      sourceType,
      originalAmount,
      originalCurrency,
      plnEquivalent
    };
  }

  const {
    payeeId: pId,
    bookingDate: bDate,
    operationDate: oDate,
    amount: amt,
    rawData: rData,
    categoryId: cId,
    importBatchId: batchId,
    sourceType: sType,
    originalAmount: oAmt,
    originalCurrency: oCurr,
    plnEquivalent: plnEq
  } = params;

  // Check if this exact transaction already exists
  const checkResult = await pool.query(
    `SELECT * FROM transactions
     WHERE payee_id = $1 AND booking_date = $2 AND amount = $3
     AND (import_batch_id = $4 OR import_batch_id IS NULL)`,
    [pId, bDate, amt, batchId]
  );

  if (checkResult.rows.length > 0) {
    const existing = checkResult.rows[0];
    // Already exists — treat as duplicate
    return { ...existing, isDuplicate: true };
  }

  const result = await pool.query(
    `INSERT INTO transactions
     (payee_id, booking_date, operation_date, amount, raw_data, category_id, import_batch_id, source_type, original_amount, original_currency, pln_equivalent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [pId, bDate, oDate, amt, JSON.stringify(rData), cId, batchId, sType || 'csv', oAmt, oCurr, plnEq]
  );
  return { ...result.rows[0], isDuplicate: false };
}

async function getPotentialDuplicates(importBatchId) {
  // Find transactions with same payee+date+amount within the same import batch
  // These are "potential duplicates" - same data but from same file (likely legitimate separate transactions)
  const result = await pool.query(
    `SELECT t1.*, p.name as payee_name
     FROM transactions t1
     JOIN transactions t2 ON t1.payee_id = t2.payee_id 
       AND t1.booking_date = t2.booking_date 
       AND t1.amount = t2.amount
       AND t1.id != t2.id
     JOIN payees p ON p.id = t1.payee_id
     WHERE t1.import_batch_id = $1
     ORDER BY t1.booking_date DESC, p.name`,
    [importBatchId]
  );
  
  // Remove duplicates from the result (since join produces pairs)
  const seen = new Set();
  return result.rows.filter(row => {
    const key = `${row.payee_id}-${row.booking_date}-${row.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  if (days === 0) {
    // Clear all transactions
    await pool.query('DELETE FROM transactions');
  } else {
    await pool.query(
      `DELETE FROM transactions 
       WHERE imported_at < CURRENT_TIMESTAMP - INTERVAL '${days} days'`
    );
  }
}

async function getUnexportedTransactions() {
  const result = await pool.query(`
    SELECT t.*, p.name as payee_name, p.normalized_name,
           m.ynab_category_id, m.ynab_category_name,
           EXISTS (
             SELECT 1 FROM transactions t2 
             WHERE t2.payee_id = t.payee_id 
               AND t2.booking_date = t.booking_date 
               AND t2.amount = t.amount 
               AND t2.id != t.id
           ) as has_duplicate
    FROM transactions t
    JOIN payees p ON p.id = t.payee_id
    LEFT JOIN mappings m ON m.id = p.mapping_id
    WHERE t.exported_to_ynab = FALSE
    ORDER BY t.booking_date DESC
  `);
  return result.rows;
}

async function markTransactionsExported(transactionIds) {
  const result = await pool.query(
    `UPDATE transactions
     SET exported_to_ynab = TRUE
     WHERE id = ANY($1::int[])
     RETURNING *`,
    [transactionIds]
  );
  return result.rows;
}

async function getLastExportedTransactionDate() {
  const result = await pool.query(`
    SELECT MAX(booking_date) as last_export_date
    FROM transactions
    WHERE exported_to_ynab = TRUE
  `);
  return result.rows[0]?.last_export_date || null;
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
          ynabCategoryId: mapping.ynabCategoryId,
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

async function deleteTransaction(id) {
  await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
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
  getPayeeByNormalizedName,
  findMappingForPayee,
  createScreenshotSession,
  getScreenshotSession,
  updateScreenshotSession,
  deleteScreenshotSession,
  markScreenshotSessionConfirmed,
  getPendingScreenshotSessions,
  createTransaction,
  getRecentTransactions,
  clearOldTransactions,
  autoCategorizeTransactions,
  getTransactionsWithCategories,
  getUnexportedTransactions,
  markTransactionsExported,
  getLastExportedTransactionDate,
  getPotentialDuplicates,
  deleteTransaction
};
