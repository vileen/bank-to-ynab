require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const db = require('./db');
const screenshotsRoutes = require('./routes/screenshots');
const fxService = require('./services/fxService');

const app = express();
const PORT = process.env.PORT || 3003;

// YNAB API config
const YNAB_API_KEY = process.env.YNAB_API_KEY;
const YNAB_BASE_URL = process.env.YNAB_BASE_URL || 'https://api.youneedabudget.com/v1';

// Auth config
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'f09e8b8a8fc1';

// Auth middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const token = authHeader.substring(7);
  if (token !== AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  next();
}

// Middleware
const allowedOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'https://ynab.vileen.pl',
  'https://vileen.github.io',
  'https://vileen.github.io/bank-to-ynab'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.FRONTEND_URL === origin) {
      callback(null, true);
    } else {
      console.warn('CORS blocked origin:', origin);
      callback(null, true);
    }
  },
  credentials: true
}));
app.use(express.json());

// Apply auth to all API routes except health check
app.use('/api', (req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  requireAuth(req, res, next);
});

// Screenshot import routes (mounted under /api/import/screenshots)
app.use('/api/import/screenshots', screenshotsRoutes);

// OKX PDF statement import routes
const okxPdfRoutes = require('./routes/okxPdf');
app.use('/api/import/okx-pdf', okxPdfRoutes);

/**
 * POST /api/import/confirm
 * Generic confirm endpoint - handles both screenshot and PDF imports.
 * Body: { importBatchId, sessionId, transactions: Array }
 */
app.post('/api/import/confirm', async (req, res) => {
  let client;
  try {
    const { importBatchId, sessionId, transactions } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'No transactions to confirm' });
    }

    // Determine source from importBatchId prefix
    const source = importBatchId?.startsWith('okx-pdf-') ? 'okx-pdf' :
                   importBatchId?.startsWith('screenshot-') ? 'okx-screenshot' :
                   'unknown';

    client = await db.pool.connect();
    await client.query('BEGIN');

    const importedTransactions = [];

    for (const tx of transactions) {
      const payeeName = tx.payee || 'Unknown';
      const normalizedName = normalizePayeeName(payeeName);
      const payee = await db.getOrCreatePayee(payeeName, normalizedName, client);

      const amountForDb = tx.plnEquivalent !== null && tx.plnEquivalent !== undefined
        ? tx.plnEquivalent
        : tx.amount;

      const rawData = {
        source,
        originalAmount: tx.originalAmount,
        originalCurrency: tx.originalCurrency,
        plnEquivalent: tx.plnEquivalent,
        exchangeRate: tx.exchangeRate,
        transactionId: tx.transactionId,
        type: tx.type,
        isRewards: tx.isRewards || false
      };

      const transaction = await db.createTransaction({
        payeeId: payee.id,
        bookingDate: tx.date,
        operationDate: tx.date,
        amount: amountForDb,
        rawData,
        categoryId: tx.categoryId || null,
        importBatchId,
        sourceType: source,
        originalAmount: tx.originalAmount,
        originalCurrency: tx.originalCurrency,
        plnEquivalent: tx.plnEquivalent,
        skipDuplicateCheck: true,
        client
      });

      importedTransactions.push({
        id: transaction.id,
        payee: payee.name,
        date: tx.date,
        amount: amountForDb
      });
    }

    await client.query('COMMIT');
    client.release();
    client = null;

    await db.autoCategorizeTransactions();

    if (sessionId) {
      await db.markScreenshotSessionConfirmed(sessionId);
    }

    res.json({
      success: true,
      importedTransactions: importedTransactions.length,
      duplicateCount: 0,
      duplicates: [],
      importBatchId,
      sessionId: sessionId || null,
      source
    });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
      client.release();
    }
    console.error('Import confirm error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: YNAB API client
const ynabApi = axios.create({
  baseURL: YNAB_BASE_URL,
  headers: {
    'Authorization': `Bearer ${YNAB_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// === API Routes ===

// Get budgets
app.get('/api/budgets', async (req, res) => {
  try {
    const response = await ynabApi.get('/budgets');
    res.json(response.data);
  } catch (error) {
    console.error('YNAB API Error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch budgets',
      details: error.response?.data?.error?.detail || error.message
    });
  }
});

// Get categories for a budget
app.get('/api/budgets/:budgetId/categories', async (req, res) => {
  try {
    const { budgetId } = req.params;
    const response = await ynabApi.get(`/budgets/${budgetId}/categories`);
    res.json(response.data);
  } catch (error) {
    console.error('YNAB API Error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch categories',
      details: error.response?.data?.error?.detail || error.message
    });
  }
});

// Get accounts for a budget
app.get('/api/budgets/:budgetId/accounts', async (req, res) => {
  try {
    const { budgetId } = req.params;
    const response = await ynabApi.get(`/budgets/${budgetId}/accounts`);
    res.json(response.data);
  } catch (error) {
    console.error('YNAB API Error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch accounts',
      details: error.response?.data?.error?.detail || error.message
    });
  }
});

// Get FX rate for currency and date
app.get('/api/fx-rate', async (req, res) => {
  try {
    const { currency, date, previousDay } = req.query;
    if (!currency || !date) {
      return res.status(400).json({ error: 'currency and date are required' });
    }
    const rate = previousDay === 'true'
      ? await fxService.getPreviousDayRate(currency, date)
      : await fxService.getRateForDate(currency, date);
    res.json({ currency, date, rate });
  } catch (error) {
    console.error('FX rate error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create transactions
app.post('/api/budgets/:budgetId/transactions', async (req, res) => {
  try {
    const { budgetId } = req.params;
    const { transactions } = req.body;
    
    const response = await ynabApi.post(`/budgets/${budgetId}/transactions`, {
      transactions
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('YNAB API Error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create transactions',
      details: error.response?.data?.error?.detail || error.message
    });
  }
});

app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteTransaction(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === Import & Payees ===

// Import transactions from CSV
app.post('/api/import', async (req, res) => {
  try {
    const { transactions, importBatchId } = req.body;
    const importedPayees = [];
    const importedTransactions = [];
    const duplicates = [];
    let duplicateCount = 0;
    
    for (const tx of transactions) {
      // Get or create payee
      const normalizedName = normalizePayeeName(tx.payee);
      const payee = await db.getOrCreatePayee(tx.payee, normalizedName);
      
      if (payee.transaction_count === 1) {
        // This is a new payee
        importedPayees.push({
          id: payee.id,
          name: payee.name,
          normalizedName: payee.normalized_name
        });
      }
      
      // Create transaction with import batch ID
      const transaction = await db.createTransaction(
        payee.id,
        tx.date,
        tx.operationDate,
        tx.amount,
        tx.rawData,
        tx.categoryId,
        importBatchId
      );
      
      if (transaction.isDuplicate) {
        duplicateCount++;
        duplicates.push({
          payee: payee.name,
          date: tx.date,
          amount: tx.amount,
          existingId: transaction.id
        });
        console.log('[IMPORT DUPLICATE]', {
          payee: payee.name,
          date: tx.date,
          amount: tx.amount,
          existingId: transaction.id
        });
      } else {
        // Add to this import's transactions list
        importedTransactions.push({
          id: transaction.id,
          payee_id: payee.id,
          payee: payee.name,
          date: tx.date,
          amount: tx.amount,
          category_id: null,
          category_name: 'Uncategorized',
          raw_data: tx.rawData
        });
      }
    }
    
    // Run auto-categorization and apply to current import
    const autoCategorized = await db.autoCategorizeTransactions();
    
    // Apply auto-categories to current import list
    importedTransactions.forEach(tx => {
      const autoMatch = autoCategorized.find(ac => ac.payeeId === tx.payee_id);
      if (autoMatch) {
        tx.category_id = autoMatch.ynabCategoryId;
        tx.category_name = autoMatch.categoryName;
      }
    });
    
    // Check for potential duplicates within the same import batch
    let potentialDuplicates = [];
    if (importBatchId) {
      potentialDuplicates = await db.getPotentialDuplicates(importBatchId);
    }
    
    res.json({
      success: true,
      importedPayees,
      importedTransactions: importedTransactions.length,
      duplicateCount,
      duplicates,
      transactions: importedTransactions,
      autoCategorized: autoCategorized.filter(ac =>
        importedTransactions.some(it => it.payee_id === ac.payeeId)
      ),
      potentialDuplicates: potentialDuplicates.map(pd => ({
        id: pd.id,
        payee: pd.payee_name,
        date: pd.operation_date || pd.booking_date,
        amount: pd.amount
      })),
      importBatchId
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get payees that need mapping
app.get('/api/payees/unmapped', async (req, res) => {
  try {
    const payees = await db.getPayeesWithoutMapping();
    res.json({ payees });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all payees with their mappings
app.get('/api/payees', async (req, res) => {
  try {
    const withMapping = await db.getPayeesWithMapping();
    const withoutMapping = await db.getPayeesWithoutMapping();
    res.json({ withMapping, withoutMapping });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Assign mapping to payee
app.post('/api/payees/:id/mapping', async (req, res) => {
  try {
    const { id } = req.params;
    const { mappingId } = req.body;
    await db.updatePayeeMapping(id, mappingId);
    res.json({ success: true });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === Category Mappings ===

// Get all mappings
app.get('/api/mappings', async (req, res) => {
  try {
    const mappings = await db.getMappingsList();
    res.json({ mappings });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save a category mapping
app.post('/api/mappings', async (req, res) => {
  try {
    const { keyword, ynabCategoryId, ynabCategoryName } = req.body;
    
    if (!keyword || !ynabCategoryId) {
      return res.status(400).json({ error: 'keyword and ynabCategoryId are required' });
    }
    
    const mapping = await db.createMapping(keyword, ynabCategoryId, ynabCategoryName);
    
    // Auto-categorize existing payees
    await db.autoCategorizeTransactions();
    
    res.json({ success: true, mapping });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a mapping
app.put('/api/mappings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { ynabCategoryId, ynabCategoryName } = req.body;
    const mapping = await db.updateMapping(id, ynabCategoryId, ynabCategoryName);
    res.json({ success: true, mapping });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a mapping
app.delete('/api/mappings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteMapping(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get unexported transactions
app.get('/api/transactions/unexported', async (req, res) => {
  try {
    const transactions = await db.getUnexportedTransactions();
    res.json({ transactions });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark transactions as exported
app.post('/api/transactions/mark-exported', async (req, res) => {
  try {
    const { transactionIds, accountId } = req.body;
    const updated = await db.markTransactionsExported(transactionIds, accountId);
    res.json({ success: true, count: updated.length });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get last exported transaction date
app.get('/api/transactions/last-exported', async (req, res) => {
  try {
    const { accountId } = req.query;
    const lastExportDate = await db.getLastExportedTransactionDate(accountId);
    res.json({ lastExportDate });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear old transactions
app.post('/api/transactions/cleanup', async (req, res) => {
  try {
    const { days = 30 } = req.body;
    await db.clearOldTransactions(days);
    res.json({ success: true });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    // Test database connection
    await db.pool.query('SELECT 1');
    
    res.json({ 
      status: 'ok', 
      database: 'connected',
      ynabConfigured: !!YNAB_API_KEY,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      database: 'disconnected',
      error: err.message,
      ynabConfigured: !!YNAB_API_KEY
    });
  }
});

// Helper function to normalize payee names
function normalizePayeeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // Replace special chars with space
    .replace(/\s+/g, ' ')         // Collapse multiple spaces
    .trim();
}

// Initialize database and start server
async function start() {
  try {
    await db.initDb();
    
    app.listen(PORT, () => {
      console.log(`🚀 Bank-to-YNAB Backend running on port ${PORT}`);
      console.log(`📊 YNAB API: ${YNAB_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
      console.log(`🗄️  Database: bank_to_ynab`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
