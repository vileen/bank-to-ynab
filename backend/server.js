require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// YNAB API config
const YNAB_API_KEY = process.env.YNAB_API_KEY;
const YNAB_BASE_URL = process.env.YNAB_BASE_URL || 'https://api.youneedabudget.com/v1';

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:8080',
  credentials: true
}));
app.use(express.json());

// Data storage for mappings (in production use database)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MAPPINGS_FILE = path.join(DATA_DIR, 'category-mappings.json');

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

// === Category Mappings ===

// Get all mappings
function getMappings() {
  if (!fs.existsSync(MAPPINGS_FILE)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8'));
}

// Save mappings
function saveMappings(mappings) {
  fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
}

// Get category mappings
app.get('/api/mappings', (req, res) => {
  const mappings = getMappings();
  res.json(mappings);
});

// Save a category mapping
app.post('/api/mappings', (req, res) => {
  const { importKeyword, ynabCategoryId, ynabCategoryName } = req.body;
  
  if (!importKeyword || !ynabCategoryId) {
    return res.status(400).json({ error: 'importKeyword and ynabCategoryId are required' });
  }
  
  const mappings = getMappings();
  mappings[importKeyword.toLowerCase()] = {
    ynabCategoryId,
    ynabCategoryName,
    createdAt: new Date().toISOString()
  };
  
  saveMappings(mappings);
  res.json({ success: true, mapping: mappings[importKeyword.toLowerCase()] });
});

// Delete a mapping
app.delete('/api/mappings/:keyword', (req, res) => {
  const { keyword } = req.params;
  const mappings = getMappings();
  
  delete mappings[keyword.toLowerCase()];
  saveMappings(mappings);
  
  res.json({ success: true });
});

// Auto-categorize transactions based on mappings
app.post('/api/auto-categorize', (req, res) => {
  const { transactions } = req.body;
  const mappings = getMappings();
  
  const categorized = transactions.map(tx => {
    const payee = (tx.payee || '').toLowerCase();
    
    // Find matching mapping
    for (const [keyword, mapping] of Object.entries(mappings)) {
      if (payee.includes(keyword.toLowerCase())) {
        return {
          ...tx,
          categoryId: mapping.ynabCategoryId,
          categoryName: mapping.ynabCategoryName,
          matchedKeyword: keyword
        };
      }
    }
    
    return tx;
  });
  
  res.json({ transactions: categorized });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    ynabConfigured: !!YNAB_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, '..')));

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Bank-to-YNAB Backend running on port ${PORT}`);
  console.log(`📊 YNAB API: ${YNAB_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`🔗 Frontend: ${process.env.FRONTEND_URL || 'http://localhost:8080'}`);
});
