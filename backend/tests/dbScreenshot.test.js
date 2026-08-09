const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');

test('database supports screenshot transaction columns', async () => {
  const unique = Date.now();
  const payee = await db.getOrCreatePayee('OKX Test Merchant ' + unique, 'okx test merchant ' + unique);

  const tx = await db.createTransaction({
    payeeId: payee.id,
    bookingDate: '2026-07-30',
    operationDate: '2026-07-30',
    amount: -33.00,
    rawData: { source: 'okx-screenshot', ocrText: 'test' },
    categoryId: null,
    importBatchId: 'screenshot-test-batch',
    sourceType: 'okx-screenshot',
    originalAmount: -33.00,
    originalCurrency: 'PLN',
    plnEquivalent: -33.00
  });

  assert.strictEqual(tx.isDuplicate, false);
  assert.strictEqual(tx.source_type, 'okx-screenshot');
  assert.strictEqual(parseFloat(tx.original_amount), -33.00);
  assert.strictEqual(tx.original_currency, 'PLN');
  assert.strictEqual(parseFloat(tx.pln_equivalent), -33.00);
  assert.strictEqual(tx.import_batch_id, 'screenshot-test-batch');

  // Cleanup
  await db.deleteTransaction(tx.id);
});

test('backward compatible createTransaction with positional args still works', async () => {
  const unique = Date.now();
  const payee = await db.getOrCreatePayee('CSV Test Merchant ' + unique, 'csv test merchant ' + unique);

  const tx = await db.createTransaction(
    payee.id,
    '2026-07-30',
    '2026-07-30',
    -12.50,
    { cols: ['test'] },
    null,
    'csv-test-batch'
  );

  assert.strictEqual(tx.isDuplicate, false);
  assert.strictEqual(tx.source_type, 'csv');
  assert.strictEqual(tx.original_amount, null);
  assert.strictEqual(tx.import_batch_id, 'csv-test-batch');

  await db.deleteTransaction(tx.id);
});
