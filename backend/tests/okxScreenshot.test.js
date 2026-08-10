const test = require('node:test');
const assert = require('node:assert');
const { parseOCRText, deduplicateTransactions, parseDate, normalizeCurrencySymbol } = require('../parsers/okxScreenshot');

test('parses simple expense and cashback pair', () => {
  const ocrText = `G Card rewards +€0.31
Jul 30, 2026 +0.36 USDG
= STARBUCKS (NSR) -zł33.00
Jul 30, 2026 -8.8 USDG`;

  const result = parseOCRText(ocrText);
  assert.strictEqual(result.transactions.length, 2);

  const cashback = result.transactions[0];
  assert.strictEqual(cashback.payee, 'OKX Card Rewards');
  assert.strictEqual(cashback.type, 'cashback');
  assert.strictEqual(cashback.originalAmount, 0.31);
  assert.strictEqual(cashback.originalCurrency, 'EUR');
  assert.strictEqual(cashback.usdgAmount, 0.36);
  assert.strictEqual(cashback.date, '2026-07-30');

  const expense = result.transactions[1];
  assert.strictEqual(expense.payee, 'STARBUCKS (NSR)');
  assert.strictEqual(expense.type, 'expense');
  assert.strictEqual(expense.originalAmount, -33.00);
  assert.strictEqual(expense.originalCurrency, 'PLN');
  assert.strictEqual(expense.usdgAmount, -8.8);
  assert.strictEqual(expense.date, '2026-07-30');
});

test('normalizes zt to PLN', () => {
  const ocrText = `= LIDL 1671 -zt45.60
Jul 31, 2026 -10.12 USDG`;

  const result = parseOCRText(ocrText);
  assert.strictEqual(result.transactions.length, 1);
  assert.strictEqual(result.transactions[0].originalCurrency, 'PLN');
  assert.strictEqual(result.transactions[0].originalAmount, -45.60);
  assert.strictEqual(result.transactions[0].payee, 'LIDL 1671');
});

test('handles Multi-crypto instead of USDG amount', () => {
  const ocrText = `G Card rewards +€0.29
Jul 30, 2026 +0.34 USDG
= McDonalds 61600180 -zł31.20
Jul 30, 2026 Multi-crypto`;

  const result = parseOCRText(ocrText);
  assert.strictEqual(result.transactions.length, 2);
  assert.strictEqual(result.transactions[1].usdgAmount, null);
  assert.strictEqual(result.transactions[1].usdgRaw, 'Multi-crypto');
  assert.strictEqual(result.transactions[1].payee, 'McDonalds 61600180');
});

test('handles ADD top-up as separate inflow', () => {
  const ocrText = `= ADD 100 -zł500.00
Aug 1, 2026 Multi-crypto`;

  const result = parseOCRText(ocrText);
  const topup = result.transactions.find(t => t.type === 'topup');
  assert.ok(topup);
  assert.strictEqual(topup.payee, 'OKX Account Top-Up');
  assert.strictEqual(topup.originalAmount, 500.00); // top-up is always positive inflow
});

test('deduplicates transactions across screenshots', () => {
  const transactions = [
    { payee: 'LIDL', date: '2026-07-30', originalAmount: -45.60, originalCurrency: 'PLN' },
    { payee: 'LIDL', date: '2026-07-30', originalAmount: -45.60, originalCurrency: 'PLN' },
    { payee: 'ORLEN', date: '2026-07-30', originalAmount: -120.00, originalCurrency: 'PLN' }
  ];

  const result = deduplicateTransactions(transactions);
  assert.strictEqual(result.length, 2);
});

test('parseDate converts MMM DD, YYYY to ISO date', () => {
  assert.strictEqual(parseDate('Jul 30, 2026'), '2026-07-30');
  assert.strictEqual(parseDate('Jan 5, 2026'), '2026-01-05');
  assert.strictEqual(parseDate('Dec 25, 2025'), '2025-12-25');
  assert.strictEqual(parseDate('not a date'), null);
});

test('normalizeCurrencySymbol handles zt and zł', () => {
  assert.strictEqual(normalizeCurrencySymbol('zt'), 'PLN');
  assert.strictEqual(normalizeCurrencySymbol('zł'), 'PLN');
  assert.strictEqual(normalizeCurrencySymbol('€'), 'EUR');
  assert.strictEqual(normalizeCurrencySymbol('$'), 'USD');
});

test('returns empty result for empty OCR text', () => {
  const result = parseOCRText('');
  assert.deepStrictEqual(result.transactions, []);
  assert.strictEqual(result.confidence.average, 0);
});

test('adds USDG top-up as topup transaction', () => {
  const ocrText = `Add $100.00 USDG
Jul 9, 2026 +100.00 USDG`;

  const result = parseOCRText(ocrText);
  assert.strictEqual(result.transactions.length, 1);
  const topup = result.transactions[0];
  assert.strictEqual(topup.type, 'topup');
  assert.strictEqual(topup.payee, 'OKX Account Top-Up');
  assert.strictEqual(topup.originalAmount, 100.00);
  assert.strictEqual(topup.originalCurrency, 'USD');
  assert.strictEqual(topup.date, '2026-07-09');
  assert.strictEqual(topup.usdgAmount, 100.00);
});

test('skips Add Pay Boost rewards', () => {
  const ocrText = `= STARBUCKS (NSR) -zł33.00
Jul 9, 2026 -8.8 USDG
Add Pay Boost
+$5.00 USDG
Jul 9, 2026 +5.00 USDG
G Card rewards +€0.31
Jul 9, 2026 +0.36 USDG`;

  const result = parseOCRText(ocrText);
  const payees = result.transactions.map(t => t.payee);
  assert.ok(!payees.includes('OKX Account Top-Up'), 'Pay Boost should not be imported as top-up');
  assert.strictEqual(result.transactions.length, 2);
  assert.strictEqual(result.transactions[0].payee, 'STARBUCKS (NSR)');
  assert.strictEqual(result.transactions[0].usdgAmount, -8.8);
  assert.strictEqual(result.transactions[1].payee, 'OKX Card Rewards');
  assert.strictEqual(result.transactions[1].usdgAmount, 0.36);
});

test('orphan cashback at end of file is still imported', () => {
  const ocrText = `G Card rewards +€0.50
Jul 30, 2026 +0.60 USDG`;

  const result = parseOCRText(ocrText);
  assert.strictEqual(result.transactions.length, 1);
  assert.strictEqual(result.transactions[0].type, 'cashback');
});

test('preserves OCR order when expense precedes cashback', () => {
  const ocrText = `= STARBUCKS (NSR) -zł33.00
Jul 30, 2026 -8.8 USDG
G Card rewards +€0.31
Jul 30, 2026 +0.36 USDG`;

  const result = parseOCRText(ocrText);
  assert.strictEqual(result.transactions.length, 2);

  assert.strictEqual(result.transactions[0].type, 'expense');
  assert.strictEqual(result.transactions[0].payee, 'STARBUCKS (NSR)');
  assert.strictEqual(result.transactions[0].date, '2026-07-30');
  assert.strictEqual(result.transactions[0].usdgAmount, -8.8);

  assert.strictEqual(result.transactions[1].type, 'cashback');
  assert.strictEqual(result.transactions[1].payee, 'OKX Card Rewards');
  assert.strictEqual(result.transactions[1].date, '2026-07-30');
  assert.strictEqual(result.transactions[1].usdgAmount, 0.36);
});

test('keeps cashback immediately after paired expense across multiple transactions', () => {
  const ocrText = `= LIDL 1671 -zt45.60
Jul 31, 2026 -10.12 USDG
G Card rewards +€0.29
Jul 31, 2026 +0.34 USDG
= ORLEN 1234 -zł120.00
Jul 31, 2026 -25.00 USDG
G Card rewards +€0.50
Jul 31, 2026 +0.60 USDG`;

  const result = parseOCRText(ocrText);
  assert.strictEqual(result.transactions.length, 4);
  assert.deepStrictEqual(result.transactions.map(t => t.payee), [
    'LIDL 1671',
    'OKX Card Rewards',
    'ORLEN 1234',
    'OKX Card Rewards'
  ]);
});
