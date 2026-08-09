const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ocr = require('../ocr/tesseract');
const okxParser = require('../parsers/okxScreenshot');
const fxService = require('../services/fxService');
const db = require('../db');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'uploads', 'screenshots');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = crypto.randomUUID();
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

/**
 * POST /api/import/screenshots
 * Upload wielu zrzutów ekranu, OCR, parsowanie, zwraca transakcje do review.
 * Nie zapisuje do bazy danych.
 */
router.post('/', upload.array('screenshots', 50), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No screenshots uploaded' });
    }

    const importBatchId = `screenshot-${Date.now()}-${crypto.randomUUID()}`;
    const allParsedTransactions = [];
    const fileResults = [];

    for (const file of files) {
      let ocrText = '';
      let parseError = null;

      try {
        ocrText = await ocr.runOCR(file.path);
      } catch (err) {
        parseError = err.message;
      }

      const parsed = parseError ? { transactions: [], confidence: { average: 0, count: 0 } } : okxParser.parseOCRText(ocrText);
      const deduped = okxParser.deduplicateTransactions(parsed.transactions);

      // Konwersja kwot na PLN dla review
      for (const tx of deduped) {
        if (tx.type === 'cashback' && tx.originalCurrency === 'EUR') {
          // Cashback EUR konwertowany stawką z dnia poprzedniego
          const prevRate = await fxService.getPreviousDayRate(tx.originalCurrency, tx.date);
          tx.plnEquivalent = prevRate !== null ? tx.originalAmount * prevRate : null;
        } else if (tx.originalCurrency && tx.originalCurrency !== 'PLN') {
          const rate = await fxService.getRateForDate(tx.originalCurrency, tx.date);
          tx.plnEquivalent = rate !== null ? tx.originalAmount * rate : null;
        } else {
          tx.plnEquivalent = tx.originalAmount;
        }

        // amount używane w reszcie aplikacji to PLN equivalent (zachowujemy znak)
        tx.amount = tx.plnEquivalent;

        // Wygeneruj id tymczasowe dla tabeli review
        tx.reviewId = `review-${crypto.randomUUID()}`;
        allParsedTransactions.push(tx);
      }

      fileResults.push({
        filename: file.originalname,
        storedFilename: file.filename,
        ocrText,
        parseError,
        transactionCount: deduped.length,
        confidence: parsed.confidence
      });
    }

    // Globalna deduplikacja pomiędzy plikami
    const finalTransactions = okxParser.deduplicateTransactions(allParsedTransactions);

    res.json({
      success: true,
      importBatchId,
      fileCount: files.length,
      transactionCount: finalTransactions.length,
      transactions: finalTransactions,
      files: fileResults
    });
  } catch (error) {
    console.error('Screenshot import error:', error);
    res.status(500).json({ error: error.message });
  }
});

function normalizePayeeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * POST /api/import/screenshots/confirm
 * Zapisuje potwierdzone transakcje do bazy danych.
 * Body: { importBatchId, transactions: Array }
 */
router.post('/confirm', async (req, res) => {
  try {
    const { importBatchId, transactions } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'No transactions to confirm' });
    }

    const importedTransactions = [];
    const duplicates = [];
    let duplicateCount = 0;

    for (const tx of transactions) {
      const payeeName = tx.payee || 'Unknown';
      const normalizedName = normalizePayeeName(payeeName);
      const payee = await db.getOrCreatePayee(payeeName, normalizedName);

      const amountForDb = tx.plnEquivalent !== null && tx.plnEquivalent !== undefined
        ? tx.plnEquivalent
        : tx.amount;

      const rawData = {
        source: 'okx-screenshot',
        originalAmount: tx.originalAmount,
        originalCurrency: tx.originalCurrency,
        plnEquivalent: tx.plnEquivalent,
        usdgAmount: tx.usdgAmount,
        usdgRaw: tx.usdgRaw,
        rawAmount: tx.rawAmount,
        type: tx.type,
        confidence: tx.confidence
      };

      const transaction = await db.createTransaction({
        payeeId: payee.id,
        bookingDate: tx.date,
        operationDate: tx.date,
        amount: amountForDb,
        rawData,
        categoryId: tx.categoryId || null,
        importBatchId,
        sourceType: 'okx-screenshot',
        originalAmount: tx.originalAmount,
        originalCurrency: tx.originalCurrency,
        plnEquivalent: tx.plnEquivalent
      });

      if (transaction.isDuplicate) {
        duplicateCount++;
        duplicates.push({
          payee: payee.name,
          date: tx.date,
          amount: amountForDb
        });
      } else {
        importedTransactions.push({
          id: transaction.id,
          payee: payee.name,
          date: tx.date,
          amount: amountForDb
        });
      }
    }

    // Auto-kategoryzacja dla nowych payees
    await db.autoCategorizeTransactions();

    res.json({
      success: true,
      importedTransactions: importedTransactions.length,
      duplicateCount,
      duplicates,
      importBatchId
    });
  } catch (error) {
    console.error('Screenshot confirm error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
