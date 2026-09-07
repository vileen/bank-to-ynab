const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const okxPdfParser = require('../parsers/okxPdf');
const fxService = require('../services/fxService');
const db = require('../db');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'uploads', 'pdfs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = crypto.randomUUID();
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

/**
 * POST /api/import/okx-pdf
 * Upload PDF statement OKX, ekstrakcja tekstu, parsowanie, zwraca transakcje do review.
 */
router.post('/', upload.single('pdf'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No PDF uploaded' });
    }

    // Ekstrakcja tekstu z PDF
    let pdfText;
    try {
      pdfText = await extractTextFromPdf(file.path);
    } catch (err) {
      console.error('PDF extraction error:', err);
      return res.status(500).json({ error: 'Failed to extract text from PDF: ' + err.message });
    }

    // Parsowanie
    const parsed = okxPdfParser.parsePdfText(pdfText);
    const deduped = okxPdfParser.deduplicateTransactions(parsed.transactions);

    const importBatchId = `okx-pdf-${Date.now()}-${crypto.randomUUID()}`;

    // Konwersja kwot na PLN dla review
    for (const tx of deduped) {
      if (tx.originalCurrency && tx.originalCurrency !== 'PLN') {
        const rate = await fxService.getRateForDate(tx.originalCurrency, tx.date);
        tx.plnEquivalent = rate !== null ? tx.originalAmount * rate : null;
      } else {
        tx.plnEquivalent = tx.originalAmount;
      }

      // amount używane w reszcie aplikacji to PLN equivalent (zachowujemy znak)
      tx.amount = tx.plnEquivalent;

      // Wygeneruj id tymczasowe dla tabeli review
      tx.reviewId = `review-${crypto.randomUUID()}`;
    }

    // Auto-mapowanie payees do istniejących kategorii
    for (const tx of deduped) {
      const payeeName = tx.payee || 'Unknown';
      const normalizedName = normalizePayeeName(payeeName);
      const existingPayee = await db.getPayeeByNormalizedName(normalizedName);

      if (existingPayee && existingPayee.ynab_category_id) {
        tx.categoryId = existingPayee.ynab_category_id;
        tx.categoryName = existingPayee.ynab_category_name;
      } else {
        const payee = await db.getOrCreatePayee(payeeName, normalizedName);
        const mapping = await db.findMappingForPayee(normalizedName);
        if (mapping) {
          tx.categoryId = mapping.ynabCategoryId;
          tx.categoryName = mapping.ynabCategoryName;
          if (!payee.mapping_id) {
            await db.updatePayeeMapping(payee.id, mapping.id);
          }
        }
      }
    }

    // Zapisz sesję review w bazie
    const sessionId = crypto.randomUUID();
    await db.createScreenshotSession(sessionId, importBatchId, {
      importBatchId,
      source: 'okx-pdf',
      fileCount: 1,
      filename: file.originalname,
      transactions: deduped,
      summary: parsed.summary,
      confidence: parsed.confidence
    });

    res.json({
      success: true,
      importBatchId,
      sessionId,
      transactionCount: deduped.length,
      transactions: deduped,
      summary: parsed.summary,
      confidence: parsed.confidence
    });
  } catch (error) {
    console.error('OKX PDF import error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Ekstrahuje tekst z PDF.
 * Używa pdftotext (poppler-utils) jeśli dostępny, w przeciwnym razie pdf-parse.
 */
async function extractTextFromPdf(filePath) {
  // Próba użycia pdftotext (najszybszy, najdokładniejszy)
  try {
    const { execSync } = require('child_process');
    const result = execSync(`pdftotext -layout "${filePath}" -`, { encoding: 'utf8', timeout: 30000 });
    if (result && result.trim().length > 100) {
      return result;
    }
  } catch (err) {
    // pdftotext nie jest dostępny — fallback
  }

  // Fallback: pdf-parse
  const pdfParse = require('pdf-parse');
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  return data.text;
}

function normalizePayeeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = router;
