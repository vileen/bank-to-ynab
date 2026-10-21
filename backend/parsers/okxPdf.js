/**
 * Parser transakcji z PDF statement OKX Card.
 * Konwertuje surowy tekst ekstrahowany z PDF na listę transakcji.
 *
 * Format PDF OKX Card Statement:
 * DATE TRANSACTION ID DESCRIPTION AMOUNT
 * Aug 5 126073019475301900007959 McDonalds 61600180 -7.23 EUR
 *                                           -31.20 PLN
 *
 * Każda transakcja to 2 linie:
 * - Linia 1: DATE, TRANSACTION ID, DESCRIPTION, AMOUNT (EUR/USD)
 * - Linia 2: AMOUNT (PLN) — zawsze pod główną kwotą, wcięta
 *
 * Specjalne przypadki:
 * - Refund: kwota dodatnia (+252.78 EUR)
 * - Multi-line description: gdy description jest długi, może zająć więcej linii
 * - Page headers/footers: "Page X of Y", "PERIOD SUMMARY", etc.
 */

const MONTHS = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12'
};

// Aug 5, Aug 25 — miesiąc + dzień (rok z kontekstu statementu)
const DATE_RE = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})/i;

// Transaction ID: 20-24 cyfrowy numer
const TX_ID_RE = /^\d{20,24}$/;

// Kwota z walutą na końcu linii: -7.23 EUR, +252.78 EUR, -31.20 PLN
// Szukamy ostatniego wystąpienia w linii
const AMOUNT_RE = /([+-]?\d+\.\d{2})\s+(EUR|PLN|USD)$/i;

// Kwota PLN w drugiej linii (zwykle wcięta, często z minusem)
const PLN_AMOUNT_RE = /^\s*([+-]?\d+\.\d{2})\s+PLN\s*$/i;

// Header/footer linie do pominięcia
const SKIP_LINES = [
  /^okx card statement/i,
  /^generated\s+\d{4}-\d{2}-\d{2}/i,
  /^card holder/i,
  /^billing address/i,
  /^primary card/i,
  /^statement period/i,
  /^transactions/i,
  /^date transaction id description amount/i,
  /^page \d+ of/i,
  /^period summary/i,
  /^total spend/i,
  /^total refund/i,
  /^total fees/i,
  /^net volume/i,
  /^rewards earned/i,
  /^this statement reflects/i,
  /^questions or disputes/i,
  /^card issued by/i,
  /^programme managed by/i,
  /^all eea countries/i,
  /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+cet/i,
  /^dominik soczewka/i,
  /^generała/i,
  /^\d{4}-\d{2}-\d{2}\s*$/i,  // samo data na końcu
];

function shouldSkipLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return SKIP_LINES.some(re => re.test(trimmed));
}

function parseMonthDay(dateStr, year) {
  const match = dateStr.match(DATE_RE);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = match[2].padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseAmount(amountStr) {
  const match = amountStr.match(AMOUNT_RE);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const currency = match[2].toUpperCase();
  return { value, currency };
}

function parsePlnAmount(line) {
  const trimmed = line.trim();
  const match = trimmed.match(PLN_AMOUNT_RE);
  if (!match) return null;
  const value = Math.abs(parseFloat(match[1]));  // PLN amount zawsze dodatni
  return { value, currency: 'PLN' };
}

function isDateLine(line) {
  return DATE_RE.test(line.trim());
}

function isTransactionId(token) {
  return TX_ID_RE.test(token);
}

/**
 * Parsuje tekst ekstrahowany z PDF OKX Card Statement.
 * @param {string} pdfText - Surowy tekst z PDF.
 * @param {string} statementYear - Rok statementu (opcjonalnie, domyślnie z nagłówka).
 * @returns {Object} - { transactions: Array, summary: Object, confidence: Object }
 */
function parsePdfText(pdfText, statementYear = null) {
  const lines = pdfText
    .split(/\r?\n/)
    .map(l => l.trimEnd())  // zachowaj wcięcia z lewej
    .filter(l => l.length > 0);

  // Wyciągnij rok z nagłówka jeśli nie podano
  if (!statementYear) {
    for (const line of lines) {
      const periodMatch = line.match(/statement period\s+\w+ \d+,? (\d{4})/i);
      if (periodMatch) {
        statementYear = periodMatch[1];
        break;
      }
    }
  }
  // Fallback: spróbuj wyciągnąć rok z pierwszej daty
  if (!statementYear) {
    for (const line of lines) {
      const dateMatch = line.match(DATE_RE);
      if (dateMatch) {
        const yearMatch = line.match(/\b(20\d{2})\b/);
        if (yearMatch) {
          statementYear = yearMatch[1];
          break;
        }
      }
    }
  }

  const transactions = [];
  let currentTx = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (shouldSkipLine(line)) {
      continue;
    }

    // Sprawdź czy to linia z datą (początek nowej transakcji)
    // Uwaga: pierwsza strona OKX PDF ma wcięcie przed datą (" Aug 5"),
    // kolejne strony są flush left ("Aug 11") — musimy trimować
    const trimmedLine = line.trim();
    const dateMatch = trimmedLine.match(DATE_RE);

    if (dateMatch) {
      // Zapisz poprzednią transakcję jeśli istnieje
      if (currentTx && currentTx.payee && currentTx.originalAmount !== null) {
        transactions.push(currentTx);
      }

      // Parsuj nową transakcję — używamy trimmedLine bo dateMatch[0] jest z trimowanego stringa
      const date = parseMonthDay(dateMatch[0], statementYear || '2026');
      const rest = trimmedLine.substring(dateMatch[0].length).trimStart();

      // Znajdź amount na końcu linii (format: -7.23 EUR)
      const amountMatch = rest.match(AMOUNT_RE);
      let amount = null;
      let txId = '';
      let payee = '';

      if (amountMatch) {
        amount = parseAmount(amountMatch[0]);
        const beforeAmount = rest.substring(0, amountMatch.index).trim();
        const tokens = beforeAmount.split(/\s+/);

        // Pierwszy token to ID transakcji
        if (tokens.length > 0 && isTransactionId(tokens[0])) {
          txId = tokens[0];
          payee = tokens.slice(1).join(' ');
        } else {
          payee = beforeAmount;
        }
      } else {
        // Brak amount w tej linii — cała reszta to description + txId
        const tokens = rest.split(/\s+/);
        if (tokens.length > 0 && isTransactionId(tokens[0])) {
          txId = tokens[0];
          payee = tokens.slice(1).join(' ');
        } else {
          payee = rest;
        }
      }

      currentTx = {
        date,
        transactionId: txId,
        payee: payee,
        originalAmount: amount ? amount.value : null,
        originalCurrency: amount ? amount.currency : null,
        plnAmount: null,
        type: amount && amount.value > 0 ? 'refund' : 'expense',
        raw: line
      };

      continue;
    }

    // Druga linia transakcji — kwota PLN (wcięta, bez daty)
    if (currentTx) {
      const pln = parsePlnAmount(line);
      if (pln && currentTx.plnAmount === null) {
        currentTx.plnAmount = pln.value;
        continue;
      }

      // Jeśli linia nie jest PLN amount, a nie mamy jeszcze originalAmount,
      // to może to być kontynuacja description (multi-line)
      if (currentTx.originalAmount === null) {
        // Sprawdź czy w tej linii jest amount
        const amountMatch = line.match(AMOUNT_RE);
        if (amountMatch) {
          const amount = parseAmount(amountMatch[0]);
          currentTx.originalAmount = amount.value;
          currentTx.originalCurrency = amount.currency;
          currentTx.type = amount.value > 0 ? 'refund' : 'expense';
          const beforeAmount = line.substring(0, amountMatch.index).trim();
          if (beforeAmount) {
            currentTx.payee += ' ' + beforeAmount;
          }
        } else {
          currentTx.payee += ' ' + line.trim();
        }
        continue;
      }
    }
  }

  // Zapisz ostatnią transakcję
  if (currentTx && currentTx.payee && currentTx.originalAmount !== null) {
    transactions.push(currentTx);
  }

  // Wyciągnij summary
  const summary = extractSummary(lines);

  return {
    transactions,
    summary,
    confidence: {
      average: transactions.length > 0 ? 0.95 : 0,
      count: transactions.length,
      year: statementYear
    }
  };
}

function extractSummary(lines) {
  const summary = {
    totalSpend: null,
    totalRefund: null,
    totalFees: null,
    netVolume: null,
    rewardsEarned: null,
    month: null
  };

  for (const line of lines) {
    const trimmed = line.trim();

    const spendMatch = trimmed.match(/^total spend\s+([+-]?\d+\.\d{2})\s+eur/i);
    if (spendMatch) summary.totalSpend = parseFloat(spendMatch[1]);

    const refundMatch = trimmed.match(/^total refund\s+([+-]?\d+\.\d{2})\s+eur/i);
    if (refundMatch) summary.totalRefund = parseFloat(refundMatch[1]);

    const feesMatch = trimmed.match(/^total fees\s+([+-]?\d+\.\d{2})\s+eur/i);
    if (feesMatch) summary.totalFees = parseFloat(feesMatch[1]);

    const netMatch = trimmed.match(/^net volume\s+([+-]?\d+\.\d{2})\s+eur/i);
    if (netMatch) summary.netVolume = parseFloat(netMatch[1]);

    const rewardsMatch = trimmed.match(/^rewards earned\s+([+-]?\d+\.\d{2})\s+eur/i);
    if (rewardsMatch) summary.rewardsEarned = parseFloat(rewardsMatch[1]);

    // Wyciągnij miesiąc z period summary (np. "August 2025")
    const periodMatch = trimmed.match(/^period summary\s+([a-z]+)\s+(\d{4})/i);
    if (periodMatch) {
      const monthName = periodMatch[1].toLowerCase();
      summary.month = MONTHS[monthName] || null;
    }
  }

  return summary;
}

/**
 * Deduplikuje transakcje na podstawie transactionId + date + amount.
 * @param {Array} transactions
 * @returns {Array}
 */
function deduplicateTransactions(transactions) {
  const seen = new Set();
  return transactions.filter(tx => {
    const key = `${tx.transactionId}|${tx.date}|${tx.originalAmount}|${tx.originalCurrency}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Tworzy transakcję rewards na podstawie summary.
 * Używa ostatniego dnia miesiąca statementu jako daty transakcji.
 * @param {Object} summary - Obiekt summary z parsePdfText.
 * @param {string} statementYear - Rok statementu.
 * @returns {Object|null} - Transakcja rewards lub null.
 */
function createRewardsTransaction(summary, statementYear) {
  if (!summary.rewardsEarned || summary.rewardsEarned <= 0) return null;

  // Użyj ostatniego dnia miesiąca jako daty rewards
  // Zakładamy że rewards są za okres statementu
  const lastDayOfMonth = new Date(parseInt(statementYear), parseInt(summary.month || 12), 0).getDate();
  const month = (summary.month || '12').padStart(2, '0');
  const date = `${statementYear}-${month}-${lastDayOfMonth}`;

  return {
    date,
    transactionId: `REWARDS-${statementYear}-${month}`,
    payee: 'OKX Card Rewards',
    originalAmount: summary.rewardsEarned,
    originalCurrency: 'EUR',
    plnAmount: null,
    type: 'income',
    raw: `Rewards earned ${summary.rewardsEarned.toFixed(2)} EUR`,
    isRewards: true
  };
}

module.exports = {
  parsePdfText,
  deduplicateTransactions,
  parseMonthDay,
  parseAmount,
  extractSummary,
  shouldSkipLine,
  createRewardsTransaction
};
