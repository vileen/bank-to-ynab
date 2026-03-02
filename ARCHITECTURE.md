# Architecture: Santander PL → YNAB

## Overview
```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────┐
│ Santander   │───▶│ Parser       │───▶│ Categorizer │───▶│ YNAB API │
│ PDF/CSV     │    │ (Regex/Text) │    │ (Rules)     │    │          │
└─────────────┘    └──────────────┘    └─────────────┘    └──────────┘
```

## Components

### 1. Parser (`parse-text.js`)
- Extracts: date, payee, amount from Santander statements
- Handles Polish number format: `1 869,19` → `1869.19`
- Works with copy-paste when PDF text extraction fails

### 2. Auto-Categorizer
Rules based on payee name:
| Pattern | Category |
|---------|----------|
| Lidl, Stokrotka, Auchan | 🛒 Groceries |
| Orlen | ⛽ Fuel |
| MPK | 🚌 Transport |
| YouTube, Spotify, Discord, Audioteka | 📺 Subscriptions |
| Trychodiet | 💇 Personal Care |
| Allegro, Amazon | 🛍️ Shopping |
| Poczta Polska | 📦 Shipping |

### 3. YNAB API Integration
- POST to `/budgets/{id}/transactions`
- Auto-categorizes (no manual entry!)
- Duplicate detection via `import_id`
- Amounts in millicents

## Your Data Summary
**27 transactions** from 2026-01-22 to 2026-02-03

| Category | Amount | % |
|----------|--------|---|
| 🛍️ Shopping | 1,748.45 PLN | 64.4% |
| 🛒 Groceries | 489.91 PLN | 18.0% |
| 💇 Hair/Personal | 180.00 PLN | 6.6% |
| ⛽ Fuel | 164.09 PLN | 6.0% |
| 📺 Subscriptions | 113.86 PLN | 4.2% |
| 📦 Shipping | 11.50 PLN | 0.4% |
| 🚌 Transport | 8.10 PLN | 0.3% |
| **TOTAL** | **2,715.91 PLN** | 100% |

## Next Steps

### Option A: Manual CSV Import (Now)
1. Run `node parse-text.js > output.csv`
2. Open YNAB → Import
3. Select CSV

### Option B: API Integration (Full automation)
1. Get YNAB API token: https://app.youneedabudget.com/settings/developer
2. Set env vars: `YNAB_TOKEN`, `YNAB_BUDGET_ID`, `YNAB_ACCOUNT_ID`
3. Run `npm run import:confirm`

### Option C: Kontomatik Integration (Future)
- Real-time bank sync
- No manual PDF handling
- Requires API credentials

## Files
- `parse-text.js` - Parser + categorizer (no dependencies)
- `santander-to-ynab.ts` - Full TypeScript version with API
- `statement.pdf` - Your Santander statement
