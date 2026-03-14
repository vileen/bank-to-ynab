const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'bank_to_ynab.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Initialize schema
function initSchema() {
  // Mappings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT UNIQUE NOT NULL,
      ynab_category_id TEXT,
      ynab_category_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_mappings_keyword ON mappings(keyword);
  `);

  // Payees table
  db.exec(`
    CREATE TABLE IF NOT EXISTS payees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      normalized_name TEXT,
      mapping_id INTEGER REFERENCES mappings(id) ON DELETE SET NULL,
      transaction_count INTEGER DEFAULT 1,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_payees_mapping ON payees(mapping_id);
    CREATE INDEX IF NOT EXISTS idx_payees_normalized ON payees(normalized_name);
  `);

  // Transactions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payee_id INTEGER REFERENCES payees(id) ON DELETE CASCADE,
      booking_date TEXT NOT NULL,
      operation_date TEXT,
      amount REAL NOT NULL,
      raw_data TEXT,
      category_id TEXT,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      exported_to_ynab INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_payee ON transactions(payee_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(booking_date);
  `);

  console.log('✅ Database schema initialized');
}

function initDb() {
  try {
    initSchema();
    console.log('✅ SQLite database connected:', DB_PATH);
    return true;
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    throw err;
  }
}

// === Mappings ===

function getMappings() {
  const stmt = db.prepare('SELECT * FROM mappings ORDER BY keyword');
  const rows = stmt.all();
  const mappings = {};
  rows.forEach(row => {
    mappings[row.keyword.toLowerCase()] = {
      id: row.id,
      ynabCategoryId: row.ynab_category_id,
      ynabCategoryName: row.ynab_category_name
    };
  });
  return mappings;
}

function getMappingsList() {
  const stmt = db.prepare(`
    SELECT m.*, COUNT(p.id) as payee_count 
    FROM mappings m 
    LEFT JOIN payees p ON p.mapping_id = m.id 
    GROUP BY m.id 
    ORDER BY m.keyword
  `);
  return stmt.all();
}

function createMapping(keyword, ynabCategoryId, ynabCategoryName) {
  const stmt = db.prepare(`
    INSERT INTO mappings (keyword, ynab_category_id, ynab_category_name) 
    VALUES (?, ?, ?) 
    ON CONFLICT(keyword) DO UPDATE SET 
      ynab_category_id = excluded.ynab_category_id,
      ynab_category_name = excluded.ynab_category_name,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `);
  return stmt.get(keyword.toLowerCase(), ynabCategoryId, ynabCategoryName);
}

function updateMapping(id, ynabCategoryId, ynabCategoryName) {
  const stmt = db.prepare(`
    UPDATE mappings 
    SET ynab_category_id = ?, ynab_category_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? 
    RETURNING *
  `);
  return stmt.get(ynabCategoryId, ynabCategoryName, id);
}

function deleteMapping(id) {
  const stmt = db.prepare('DELETE FROM mappings WHERE id = ?');
  stmt.run(id);
}

// === Payees ===

function getOrCreatePayee(name, normalizedName) {
  // Try to find existing payee
  let stmt = db.prepare('SELECT * FROM payees WHERE normalized_name = ?');
  let payee = stmt.get(normalizedName.toLowerCase());
  
  if (payee) {
    // Update last seen and count
    const updateStmt = db.prepare(`
      UPDATE payees 
      SET transaction_count = transaction_count + 1, 
          last_seen_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `);
    updateStmt.run(payee.id);
    
    // Return updated payee
    stmt = db.prepare('SELECT * FROM payees WHERE id = ?');
    return stmt.get(payee.id);
  }
  
  // Create new payee
  stmt = db.prepare(`
    INSERT INTO payees (name, normalized_name) 
    VALUES (?, ?) 
    RETURNING *
  `);
  return stmt.get(name, normalizedName.toLowerCase());
}

function getPayeesWithoutMapping() {
  const stmt = db.prepare(`
    SELECT p.* 
    FROM payees p 
    WHERE p.mapping_id IS NULL 
    ORDER BY p.transaction_count DESC, p.last_seen_at DESC
  `);
  return stmt.all();
}

function getPayeesWithMapping() {
  const stmt = db.prepare(`
    SELECT p.*, m.keyword, m.ynab_category_id, m.ynab_category_name
    FROM payees p
    JOIN mappings m ON m.id = p.mapping_id
    ORDER BY p.transaction_count DESC
  `);
  return stmt.all();
}

function updatePayeeMapping(payeeId, mappingId) {
  const stmt = db.prepare('UPDATE payees SET mapping_id = ? WHERE id = ?');
  stmt.run(mappingId, payeeId);
}

function findPayeesByKeyword(keyword) {
  const stmt = db.prepare(`
    SELECT * FROM payees 
    WHERE normalized_name LIKE ? 
    ORDER BY transaction_count DESC
  `);
  return stmt.all(`%${keyword.toLowerCase()}%`);
}

// === Transactions ===

function createTransaction(payeeId, bookingDate, operationDate, amount, rawData, categoryId = null) {
  const stmt = db.prepare(`
    INSERT INTO transactions 
    (payee_id, booking_date, operation_date, amount, raw_data, category_id) 
    VALUES (?, ?, ?, ?, ?, ?) 
    RETURNING *
  `);
  return stmt.get(payeeId, bookingDate, operationDate, amount, JSON.stringify(rawData), categoryId);
}

function getRecentTransactions(limit = 100) {
  const stmt = db.prepare(`
    SELECT t.*, p.name as payee_name, p.normalized_name,
           m.ynab_category_id, m.ynab_category_name
    FROM transactions t
    JOIN payees p ON p.id = t.payee_id
    LEFT JOIN mappings m ON m.id = p.mapping_id
    ORDER BY t.booking_date DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

function clearOldTransactions(days = 30) {
  const stmt = db.prepare(`
    DELETE FROM transactions 
    WHERE imported_at < datetime('now', '-${days} days')
  `);
  stmt.run();
}

// === Auto-categorization ===

function autoCategorizeTransactions() {
  // Get all payees that don't have a mapping
  const payeesStmt = db.prepare(`
    SELECT p.id, p.normalized_name 
    FROM payees p 
    WHERE p.mapping_id IS NULL
  `);
  const payees = payeesStmt.all();
  
  const mappings = getMappings();
  const categorized = [];
  
  const updateStmt = db.prepare('UPDATE payees SET mapping_id = ? WHERE id = ?');
  
  for (const payee of payees) {
    const payeeName = payee.normalized_name.toLowerCase();
    
    // Find matching keyword
    for (const [keyword, mapping] of Object.entries(mappings)) {
      if (payeeName.includes(keyword.toLowerCase())) {
        // Update payee with mapping
        updateStmt.run(mapping.id, payee.id);
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

function getTransactionsWithCategories() {
  const stmt = db.prepare(`
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
    WHERE t.exported_to_ynab = 0
    ORDER BY t.booking_date DESC
  `);
  return stmt.all();
}

module.exports = {
  db,
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
