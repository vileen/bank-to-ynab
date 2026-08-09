# Plan: OKX Card Screenshot Import

## Context

OKX card activity has no transaction export. The only way to get data into the budgeting app is by taking screenshots of the OKX app Activity screen and extracting transactions automatically.

July 2026 produced 22 screenshots. Two sample screenshots were analyzed with OCR.

## Data Structure Observed in Screenshots

Each screenshot shows a vertical list of transactions from the OKX app **Activity** tab.

Transaction pattern:

- Merchant name on one line  
  Examples: `McDonalds 478 Lublin O`, `TRANSGOURMET`, `ZABKA Z2068 K.2`, `STARBUCKS (NSR)`, `DAMIAN NIZIO`, `LIDL 1671`
- Date on the next line  
  Example: `Jul 30, 2026` (repeated under every transaction)
- For payments: negative amount in local currency + negative amount in USDG  
  Examples: `-zł40.20`, `-10.73 USDG`
- For card rewards (cashback): positive amount in EUR + positive amount in USDG  
  Examples: `+€0.37`, `+0.43 USDG`
- UI filters at the top: `Type: All`, `Custom`, `Card rewards`
- Bottom navigation bar: `Portfolio`, `Explore`, `Activity`, `Pay`

## OCR-Specific Challenges

- `zł` (Polish złoty) is often misread as `zt` by Tesseract. Parser must normalize both to `PLN`.
- Multiple transaction blocks per screenshot.
- Card rewards are separate list items but logically tied to the preceding purchase.
- Same date is repeated under every transaction; grouping by date is not needed for parsing, only for display.
- Currency symbols can be `zł`, `zt`, `€`, or token labels like `USDG`.
- Screenshot resolution/orientation may vary slightly depending on device.

## Proposed Architecture

Keep the existing `bank-to-ynab` flow and add a new input source: **Screenshot Import**.

Components:

1. **Frontend — Screenshot Upload View**
   - New tab next to CSV import: `Screenshots`.
   - Multi-file image upload (drag & drop or file picker).
   - Upload progress indicator (useful for 22 images).
   - Preview grid of uploaded screenshots.
   - Review table after OCR: editable merchant, date, amount, currency, reward flag.
   - Manual merge/split tools for when OCR misses a line.

2. **Backend — Image Processing Endpoint**
   - `POST /api/import/screenshots` — accepts multipart/form-data with multiple images.
   - Run OCR on each image using Tesseract (already installed on host).
   - Return raw OCR text and parsed transactions for review.
   - Do not write to database until user confirms the parsed data.

3. **Backend — OKX Parser**
   - `backend/parsers/okxScreenshot.js`
   - Heuristic state machine:
     - Detect merchant name line.
     - Detect date line following merchant.
     - Detect amount lines (one or two currency lines).
     - Detect `Card rewards` keyword and attach reward to previous transaction.
   - Normalization:
     - `zt` → `zł` → `PLN`.
     - `€` → `EUR`.
     - `USDG` kept as is (crypto stablecoin unit).
     - Strip whitespace and plus/minus signs for numeric parsing.

4. **Storage Integration**
   - Reuse existing tables: `payees`, `transactions`, `mappings`.
   - Add a new `source` column or use `raw_data` JSON to mark source as `okx-screenshot`.
   - Add `import_batch_id` to group screenshots from the same upload session.
   - Store raw OCR text in `raw_data` for debugging.

5. **Cashback / Rewards Handling**
   - Card rewards are separate transactions in the list but represent income.
   - Option A: merge reward into the original purchase as a split transaction (spend + reward).
   - Option B: import reward as a separate inflow transaction with payee `OKX Card Rewards` and category `Income: Cashback`.
   - Recommended: Option B — simpler, matches YNAB inflow model, easier to audit.

6. **YNAB Export Integration**
   - Reuse existing `/api/budgets/:budgetId/transactions` endpoint.
   - Map local currency (PLN) to YNAB amount (Ynab uses milliunits, signed integer).
   - Use existing payee normalization and mapping engine.
   - Mark transactions as exported via existing `mark-exported` flow.

## Suggested Database Changes

```sql
-- Track source type for transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'csv';

-- Store raw OCR text for screenshots
-- Already stored in raw_data JSONB, add key: { "source": "okx-screenshot", "ocrText": "..." }

-- Optional: store screenshot files for audit trail
CREATE TABLE IF NOT EXISTS screenshot_imports (
    id SERIAL PRIMARY KEY,
    import_batch_id VARCHAR(255) NOT NULL,
    filename VARCHAR(500),
    ocr_text TEXT,
    parsed_transaction_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Implementation Roadmap

### Phase 1 — OCR Proof of Concept
- Create a standalone script `backend/scripts/test-okx-ocr.js`.
- Feed all 22 July screenshots into Tesseract.
- Dump raw OCR text to JSON and inspect failure patterns.
- Adjust Tesseract config (PSM 6, whitelist characters) and image preprocessing if needed.

### Phase 2 — Parser Prototype
- Implement `backend/parsers/okxScreenshot.js`.
- Unit test against sample OCR outputs from Phase 1.
- Handle edge cases: missing dates, merged lines, rewards, foreign currency, refunds.

### Phase 3 — Backend Upload Endpoint
- Add `multer` dependency for multipart upload.
- Implement `POST /api/import/screenshots` with review response (no DB write yet).
- Add `POST /api/import/screenshots/confirm` to commit reviewed transactions to DB.

### Phase 4 — Frontend UI
- Add `Screenshots` tab.
- Multi-file upload + preview grid.
- Review table with editable fields.
- Show raw OCR side-by-side for each transaction to speed up manual correction.
- Add `Import to YNAB` button after review.

### Phase 5 — Cashback & Polish OCR Hardening
- Normalize `zt` to `zł` in parser.
- Add reward detection and import as `OKX Card Rewards` inflow.
- Add confidence scores per field so the UI can highlight low-confidence rows.

### Phase 6 — Testing & Deploy
- Add unit tests for parser (target: 70% coverage per project standard).
- Add integration test for upload + confirm flow.
- Update README with OKX screenshot instructions.
- Deploy backend via PM2 and frontend via GitHub Pages.

## Open Questions to Resolve

1. Should the parser assume all amounts are in PLN if the symbol is `zł`/`zt`? Or should it support EUR/GBP/etc. for travel transactions?
2. How should the app handle the USDG amount? Ignore it or store it in `raw_data` for reference?
3. Should card rewards be imported as separate inflow transactions or merged into the original purchase?
4. Are the 22 screenshots in chronological order? If not, the parser should sort by parsed date.
5. Does OKX ever show pending vs. completed status? If yes, the parser should ignore pending transactions.

## Risks & Mitigations

- **OCR quality varies.** Mitigation: add review UI and confidence scores.
- **Privacy of financial screenshots.** Mitigation: process OCR locally with Tesseract; do not send images to cloud APIs.
- **Duplicate imports across months.** Mitigation: use existing payee+date+amount duplicate detection in `createTransaction`.
- **Cashback double counting.** Mitigation: clearly separate rewards from purchases during import.

## Files to Create or Modify

New files:
- `backend/parsers/okxScreenshot.js`
- `backend/scripts/test-okx-ocr.js`
- `backend/routes/screenshots.js` (optional, to keep server.js clean)
- `frontend/js/screenshots.js` or inline section in `index.html`
- `backend/tests/okxScreenshot.test.js`

Modified files:
- `backend/server.js` — add screenshot endpoints
- `backend/db.js` — add `source_type` column handling if needed
- `backend/schema.sql` — add screenshot imports table if needed
- `index.html` — add Screenshots tab
- `README.md` — document OKX screenshot workflow
- `backend/package.json` — add `multer`

## Success Criteria

- Uploading all 22 July screenshots produces a review list with >90% of transactions parsed correctly without manual editing.
- Manual review + edit takes under 5 minutes per month.
- Imported transactions are correctly deduplicated and categorized via existing mapping engine.
- Card rewards are imported as separate inflow transactions.
- All new code has tests and passes `npm test` in backend.
