require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3003;

// YNAB API config
const YNAB_API_KEY = process.env.YNAB_API_KEY;
const YNAB_BASE_URL = process.env.YNAB_BASE_URL || 'https://api.youneedabudget.com/v1';

// Middleware
const allowedOrigins = [
  'http://localhost:8080',
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

// === Import & Payees ===

// Import transactions from CSV
app.post('/api/import', async (req, res) => {
  try {
    const { transactions } = req.body;
    const importedPayees = [];
    const importedTransactions = [];
    
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
      
      // Create transaction
      const transaction = await db.createTransaction(
        payee.id,
        tx.date,
        tx.operationDate,
        tx.amount,
        tx.rawData,
        tx.categoryId
      );
      
      importedTransactions.push(transaction);
    }
    
    // Run auto-categorization
    const autoCategorized = await db.autoCategorizeTransactions();
    
    res.json({
      success: true,
      importedPayees,
      importedTransactions: importedTransactions.length,
      autoCategorized
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

// Get transactions ready for export
app.get('/api/transactions/export', async (req, res) => {
  try {
    const transactions = await db.getTransactionsWithCategories();
    res.json({ transactions });
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
app.get('/api/health', (req, res) => {
  try {
    // Test database connection - SQLite is synchronous
    db.db.prepare('SELECT 1').get();
    
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
