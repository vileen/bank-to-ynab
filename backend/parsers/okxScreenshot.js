/**
 * Parser transakcji ze zrzutów ekranu OKX Activity.
 * Konwertuje surowy tekst OCR na listę transakcji.
 */

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

const DATE_RE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})/i;

// Wyrażenia do wykrywania kwot z symbolami walut.
// Obsługujemy: zł, zt (OCR artefakt), €, $, USDG, Multi-crypto
const AMOUNT_RE = /([+-]?\s*[\d\s]+[.,]\d{2}|\+?\d+\.\d+|\-\d+\.\d+)?\s*(zł|zt|€|\$|USDG|Multi-crypto)?/i;
// Formaty kwot: -zł33.00, +€0.31, 33.00 zł, 33.00zt
const CURRENCY_AMOUNT_RE = /([+-]?)\s*(zł|zt|€|\$)?\s*([\d\s]+[.,]?\d*)\s*(zł|zt|€|\$)?/gi;

function normalizeCurrencySymbol(symbol) {
  if (!symbol) return null;
  const s = symbol.toLowerCase().trim();
  if (s === 'zt' || s === 'zł') return 'PLN';
  if (s === '€') return 'EUR';
  if (s === '$') return 'USD';
  return symbol.toUpperCase();
}

function normalizeAmount(amountStr) {
  if (!amountStr) return null;
  return amountStr
    .replace(/\s+/g, '')
    .replace(',', '.');
}

function parseAmountNumber(amountStr) {
  const normalized = normalizeAmount(amountStr);
  if (!normalized) return null;
  const value = parseFloat(normalized);
  return isNaN(value) ? null : value;
}

function parseDate(dateStr) {
  const match = dateStr.match(DATE_RE);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = match[2].padStart(2, '0');
  const year = match[3];
  return `${year}-${month}-${day}`;
}

function isValidCurrencyMatch(match) {
  const rawAmount = match[3];
  const symbol = match[2] || match[4];
  return symbol && /\d/.test(rawAmount);
}

function hasCurrencyAmount(line) {
  const matches = [...line.matchAll(CURRENCY_AMOUNT_RE)];
  return matches.some(isValidCurrencyMatch);
}

function extractCurrencyAmount(line) {
  const matches = [...line.matchAll(CURRENCY_AMOUNT_RE)];
  const validMatch = matches.find(isValidCurrencyMatch);
  if (!validMatch) return null;
  const sign = validMatch[1] || '';
  const rawAmount = validMatch[3];
  const symbol = validMatch[2] || validMatch[4];
  const amount = parseAmountNumber(rawAmount);
  if (amount === null || !symbol) return null;
  const signedAmount = sign === '-' ? -amount : amount;
  return {
    amount: signedAmount,
    currency: normalizeCurrencySymbol(symbol),
    raw: `${sign}${rawAmount}${symbol}`.trim()
  };
}

function extractUSDG(line) {
  // Rozpoznaje: +0.36 USDG, -8.8 USDG, Multi-crypto (z lub bez USDG)
  if (/Multi-crypto/i.test(line)) {
    return { value: null, raw: 'Multi-crypto', sign: '' };
  }
  const match = line.match(/([+-]?)\s*([\d\s]+[.,]?\d*)\s*USDG/i);
  if (match) {
    const sign = match[1] || '';
    const raw = match[2];
    const value = parseAmountNumber(raw);
    return { value: value !== null ? (sign === '-' ? -value : value) : null, raw: `${sign}${raw} USDG`.trim(), sign };
  }
  return null;
}

function isDateLine(line) {
  return DATE_RE.test(line.trim());
}

function extractDateFromLine(line) {
  const match = line.trim().match(DATE_RE);
  if (!match) return null;
  return parseDate(match[0]);
}

function isCardRewardsLine(line) {
  return /card\s+rewards/i.test(line);
}

function isAddLine(line) {
  return /\bADD\b/i.test(line) && !/pay\s*boost/i.test(line);
}

function isPayBoostLine(line) {
  return /pay\s*boost/i.test(line);
}

function containsUSDG(line) {
  return /USDG/i.test(line) || /Multi-crypto/i.test(line);
}

function cleanPayeeName(name) {
  // Usuń ikonkę "=" na początku, nadmiarowe spacje, "G " prefix
  return name
    .replace(/^[=G\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPayeeAndAmount(line) {
  // Szukamy wszystkich wystąpień kwot z walutą w linii
  const matches = [...line.matchAll(CURRENCY_AMOUNT_RE)];
  const validMatches = matches.filter(isValidCurrencyMatch);
  if (validMatches.length === 0) return null;

  // Weź ostatnie dopasowanie jako główna kwota (zazwyczaj na końcu linii)
  const lastMatch = validMatches[validMatches.length - 1];
  const sign = lastMatch[1] || '';
  const rawAmount = lastMatch[3];
  const symbol = lastMatch[2] || lastMatch[4];
  const amount = parseAmountNumber(rawAmount);
  if (amount === null || !symbol) return null;

  const payeePart = line.substring(0, lastMatch.index).trim();
  const payee = cleanPayeeName(payeePart);

  return {
    payee: payee || 'Unknown',
    amount: sign === '-' ? -amount : amount,
    currency: normalizeCurrencySymbol(symbol),
    raw: `${sign}${rawAmount}${symbol}`.trim()
  };
}

/**
 * Parsuje tekst OCR z zrzutu ekranu OKX.
 * @param {string} ocrText - Surowy tekst z OCR.
 * @param {Object} options - Opcje parsera.
 * @returns {Object} - { transactions: Array, confidence: Object }
 */
function parseOCRText(ocrText) {
  const lines = ocrText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const transactions = [];
  let currentDate = null;
  let inSkipBlock = false;

  function getLastTransaction() {
    if (transactions.length > 0) return transactions[transactions.length - 1];
    return null;
  }

  function attachUSDGToLastTransaction(usdg) {
    if (!usdg) return;
    const lastTx = getLastTransaction();
    if (!lastTx) return;
    lastTx.usdgAmount = usdg.value;
    lastTx.usdgRaw = usdg.raw;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Data-only line sets context for subsequent transactions.
    // Date + USDG line is treated as a detail line for the immediately preceding transaction.
    if (isDateLine(line)) {
      const parsedDate = extractDateFromLine(line);

      if (containsUSDG(line)) {
        const usdg = extractUSDG(line);
        if (inSkipBlock) {
          // Skip USDG detail lines belonging to ignored Pay Boost block.
          continue;
        } else {
          const lastTx = getLastTransaction();
          if (lastTx) {
            attachUSDGToLastTransaction(usdg);
            if (!lastTx.date) lastTx.date = parsedDate;
          } else {
            currentDate = parsedDate;
          }
        }
      } else {
        currentDate = parsedDate;
      }
      continue;
    }

    // Skip Pay Boost rewards - they are not real transactions.
    if (isPayBoostLine(line)) {
      inSkipBlock = true;
      continue;
    }

    // ADD - account top-up (always inflow, ignore minus sign from OCR).
    // Must be checked before standalone USDG so "Add $100 USDG" is parsed as a top-up.
    if (isAddLine(line)) {
      inSkipBlock = false;
      const extracted = extractCurrencyAmount(line);
      if (extracted) {
        transactions.push({
          date: currentDate,
          payee: 'OKX Account Top-Up',
          type: 'topup',
          originalAmount: Math.abs(extracted.amount),
          originalCurrency: extracted.currency,
          rawAmount: extracted.raw,
          usdgAmount: null,
          usdgRaw: null,
          confidence: 0.7
        });
      } else {
        transactions.push({
          date: currentDate,
          payee: 'OKX Account Top-Up',
          type: 'topup',
          originalAmount: null,
          originalCurrency: null,
          rawAmount: line,
          usdgAmount: null,
          usdgRaw: null,
          confidence: 0.5
        });
      }
      continue;
    }

    // Standalone USDG detail line - attach to immediately preceding transaction.
    if (containsUSDG(line)) {
      if (inSkipBlock) continue;
      const usdg = extractUSDG(line);
      attachUSDGToLastTransaction(usdg);
      continue;
    }

    // Card rewards - cashback.
    if (isCardRewardsLine(line)) {
      inSkipBlock = false;
      const extracted = extractCurrencyAmount(line);
      if (extracted) {
        transactions.push({
          date: currentDate,
          payee: 'OKX Card Rewards',
          type: 'cashback',
          originalAmount: extracted.amount,
          originalCurrency: extracted.currency,
          rawAmount: extracted.raw,
          usdgAmount: null,
          usdgRaw: null,
          confidence: 0.85
        });
      }
      continue;
    }

    // Expense transaction.
    if (hasCurrencyAmount(line)) {
      inSkipBlock = false;
      const extracted = extractPayeeAndAmount(line);
      if (extracted) {
        transactions.push({
          date: currentDate,
          payee: extracted.payee,
          type: 'expense',
          originalAmount: extracted.amount,
          originalCurrency: extracted.currency,
          rawAmount: extracted.raw,
          usdgAmount: null,
          usdgRaw: null,
          confidence: 0.8
        });
      }
      continue;
    }
  }

  return {
    transactions,
    confidence: {
      average: transactions.length > 0
        ? transactions.reduce((sum, t) => sum + (t.confidence || 0), 0) / transactions.length
        : 0,
      count: transactions.length
    }
  };
}

/**
 * Deduplikuje transakcje na podstawie payee + date + amount.
 * @param {Array} transactions
 * @returns {Array}
 */
function deduplicateTransactions(transactions) {
  const seen = new Set();
  return transactions.filter(tx => {
    const key = `${tx.payee}|${tx.date}|${tx.originalAmount}|${tx.originalCurrency}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  parseOCRText,
  deduplicateTransactions,
  parseDate,
  normalizeCurrencySymbol,
  parseAmountNumber
};
