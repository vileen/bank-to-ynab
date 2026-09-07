const test = require('node:test');
const assert = require('node:assert');
const { parsePdfText, deduplicateTransactions, parseMonthDay, parseAmount, extractSummary, shouldSkipLine } = require('../parsers/okxPdf');

// --- Przykładowy tekst z PDF (fragment) ---
const SAMPLE_PDF_TEXT = `OKX Card Statement
Generated 2026-09-03 08:32 CET
CARD HOLDER
DOMINIK SOCZEWKA
STATEMENT PERIOD
August 1, 2026 - August 31, 2026
TRANSACTIONS
DATE TRANSACTION ID DESCRIPTION AMOUNT
Aug 5 126073019475301900007959 McDonalds 61600180 -7.23 EUR
-31.20 PLN
Aug 6 126080603475748600004054 McDonalds 478 Lublin 0 -11.12 EUR
-47.70 PLN
Aug 7 126080616180762600002212 LIDL 1671 -5.31 EUR
-22.80 PLN
Aug 10 126081000255117000004879 MOONSHOT AI -33.87 EUR
-39.00 USD
Aug 10 126081000371580500000244 PGE ePlatnosci ebok on -307.88 EUR
-1321.44 PLN
Aug 27 126082617153833500003606 PRO*CASTORAMA POLSKA +252.78 EUR
+1086.97 PLN
Aug 31 126083021425568500000971 Pyszne.pl -24.99 EUR
-107.99 PLN
Page 1 of 7
PERIOD SUMMARY
Total spend -1887.23 EUR
Total refund +252.78 EUR
Total fees +0.00 EUR
Net Volume -1634.45 EUR
Rewards earned +87.26 EUR`;

test('parses expense transaction', () => {
  const result = parsePdfText(SAMPLE_PDF_TEXT, '2026');
  const tx = result.transactions.find(t => t.payee.includes('McDonalds') && t.payee.includes('61600180'));
  assert.ok(tx, 'Transaction should be found');
  assert.strictEqual(tx.date, '2026-08-05');
  assert.strictEqual(tx.transactionId, '126073019475301900007959');
  assert.strictEqual(tx.originalAmount, -7.23);
  assert.strictEqual(tx.originalCurrency, 'EUR');
  assert.strictEqual(tx.plnAmount, 31.20);  // PLN zawsze dodatni
  assert.strictEqual(tx.type, 'expense');
});

test('parses transaction with zero in description', () => {
  const result = parsePdfText(SAMPLE_PDF_TEXT, '2026');
  const tx = result.transactions.find(t => t.payee.includes('McDonalds') && t.payee.includes('478'));
  assert.ok(tx, 'Transaction with 0 in description should be found');
  assert.strictEqual(tx.payee, 'McDonalds 478 Lublin 0');
  assert.strictEqual(tx.originalAmount, -11.12);
  assert.strictEqual(tx.plnAmount, 47.70);  // PLN zawsze dodatni
});

test('parses refund transaction (positive amount)', () => {
  const result = parsePdfText(SAMPLE_PDF_TEXT, '2026');
  const tx = result.transactions.find(t => t.payee.includes('CASTORAMA'));
  assert.ok(tx, 'Refund transaction should be found');
  assert.strictEqual(tx.originalAmount, 252.78);
  assert.strictEqual(tx.type, 'refund');
  assert.strictEqual(tx.plnAmount, 1086.97);  // PLN zawsze dodatni
});

test('parses transaction with USD amount', () => {
  const result = parsePdfText(SAMPLE_PDF_TEXT, '2026');
  const tx = result.transactions.find(t => t.payee.includes('MOONSHOT'));
  assert.ok(tx, 'USD transaction should be found');
  assert.strictEqual(tx.originalAmount, -33.87);
  assert.strictEqual(tx.originalCurrency, 'EUR');  // EUR jest główną walutą w statement
  // W PDF druga linia to -39.00 USD (nie PLN), więc plnAmount = null
  assert.strictEqual(tx.plnAmount, null);
});

test('parses large amount transaction', () => {
  const result = parsePdfText(SAMPLE_PDF_TEXT, '2026');
  const tx = result.transactions.find(t => t.payee.includes('PGE'));
  assert.ok(tx, 'PGE transaction should be found');
  assert.strictEqual(tx.originalAmount, -307.88);
  assert.strictEqual(tx.plnAmount, 1321.44);  // PLN zawsze dodatni
});

test('extracts summary correctly', () => {
  const result = parsePdfText(SAMPLE_PDF_TEXT, '2026');
  assert.strictEqual(result.summary.totalSpend, -1887.23);
  assert.strictEqual(result.summary.totalRefund, 252.78);
  assert.strictEqual(result.summary.totalFees, 0.00);
  assert.strictEqual(result.summary.netVolume, -1634.45);
  assert.strictEqual(result.summary.rewardsEarned, 87.26);
});

test('skips header and footer lines', () => {
  assert.strictEqual(shouldSkipLine('OKX Card Statement'), true);
  assert.strictEqual(shouldSkipLine('Generated 2026-09-03 08:32 CET'), true);
  assert.strictEqual(shouldSkipLine('Page 1 of 7'), true);
  assert.strictEqual(shouldSkipLine('Total spend -1887.23 EUR'), true);
  assert.strictEqual(shouldSkipLine('Aug 5 126073019475301900007959 McDonalds -7.23 EUR'), false);
});

test('parseMonthDay converts month abbreviations', () => {
  assert.strictEqual(parseMonthDay('Aug 5', '2026'), '2026-08-05');
  assert.strictEqual(parseMonthDay('Aug 25', '2026'), '2026-08-25');
  assert.strictEqual(parseMonthDay('Dec 31', '2025'), '2025-12-31');
  assert.strictEqual(parseMonthDay('Jan 1', '2026'), '2026-01-01');
  assert.strictEqual(parseMonthDay('not a date', '2026'), null);
});

test('parseAmount handles positive and negative', () => {
  assert.deepStrictEqual(parseAmount('-7.23 EUR'), { value: -7.23, currency: 'EUR' });
  assert.deepStrictEqual(parseAmount('+252.78 EUR'), { value: 252.78, currency: 'EUR' });
  assert.deepStrictEqual(parseAmount('-31.20 PLN'), { value: -31.20, currency: 'PLN' });
  assert.strictEqual(parseAmount('not an amount'), null);
});

test('deduplicates transactions by transactionId', () => {
  const txs = [
    { transactionId: '123', date: '2026-08-05', originalAmount: -10, originalCurrency: 'EUR' },
    { transactionId: '123', date: '2026-08-05', originalAmount: -10, originalCurrency: 'EUR' },
    { transactionId: '456', date: '2026-08-06', originalAmount: -20, originalCurrency: 'EUR' }
  ];
  const result = deduplicateTransactions(txs);
  assert.strictEqual(result.length, 2);
});

test('returns empty result for empty text', () => {
  const result = parsePdfText('');
  assert.deepStrictEqual(result.transactions, []);
  assert.strictEqual(result.confidence.count, 0);
});

test('handles single transaction', () => {
  const text = `Aug 5 126073019475301900007959 McDonalds -7.23 EUR
-31.20 PLN`;
  const result = parsePdfText(text, '2026');
  assert.strictEqual(result.transactions.length, 1);
  assert.strictEqual(result.transactions[0].payee, 'McDonalds');
  assert.strictEqual(result.transactions[0].originalAmount, -7.23);
});

test('handles transaction without PLN line', () => {
  const text = `Aug 5 126073019475301900007959 McDonalds -7.23 EUR`;
  const result = parsePdfText(text, '2026');
  assert.strictEqual(result.transactions.length, 1);
  assert.strictEqual(result.transactions[0].plnAmount, null);
});
