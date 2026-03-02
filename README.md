# Bank CSV → YNAB Importer

Web UI do importu transakcji z polskich banków do YNAB z auto-kategoryzacją.

## Obsługiwane banki

| Bank | Status | Uwagi |
|------|--------|-------|
| 🇵🇱 **Santander Polska** | ✅ Gotowe | Karta kredytowa, eksport CSV |
| 🇵🇱 mBank | 🚧 Planowane | - |
| 🇵🇱 ING | 🚧 Planowane | - |
| 🇵🇱 PKO BP | 🚧 Planowane | - |
| 🇵🇱 Pekao | 🚧 Planowane | - |

## Features
- 🏛️ **Wybór banku** — każdy bank ma swój parser formatu CSV
- 📁 Upload CSV (drag & drop)
- 📅 Pamięta datę ostatniego importu per bank (localStorage)
- 🏷️ Auto-kategorie (Lidl, Allegro, Spotify, etc.)
- 🔍 Filtry (tylko nowe / tylko wydatki / kategoria)
- 📊 Podsumowanie wydatków
- 📥 Eksport CSV gotowy do YNAB

## Deploy na GitHub Pages

### 1. Stwórz repo na GitHub
```bash
# Utwórz nowe repo "bank-to-ynab" na GitHub.com
```

### 2. Wypushuj kod
```bash
cd ~/santander-to-ynab  # lub przenieś folder
mv santander-to-ynab bank-to-ynab  # opcjonalnie: zmień nazwę folderu
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/vileen/bank-to-ynab.git
git push -u origin main
```

### 3. Włącz GitHub Pages
- Wejdź w repo → Settings → Pages
- Source: Deploy from a branch
- Branch: main / (root)
- Save

### 4. Gotowe!
Appka będzie dostępna pod:
`https://vileen.github.io/bank-to-ynab`

## Dodawanie nowego banku

Chcesz dodać wsparcie dla innego banku? Wystarczy dodać parser w `index.html`:

```javascript
const BANK_CONFIGS = {
    santander: {
        name: 'Santander Polska',
        hint: 'Obsługuje eksport z Santander internet',
        parse: parseSantanderCSV,
    },
    mbank: {
        name: 'mBank',
        hint: 'Eksport z mBanku (historia operacji)',
        parse: parseMbankCSV,
    }
};
```

## Usage
1. Wybierz bank z listy
2. Wrzuć CSV wyeksportowany z banku
3. Zobacz podsumowanie i nowe transakcje
4. Kliknij "Eksportuj do YNAB CSV"
5. Import w YNAB → gotowe!

## Auto-kategorie

Aplikacja automatycznie przypisuje kategorie na podstawie nazwy payee:

| Pattern | Kategoria |
|---------|-----------|
| Lidl, Stokrotka, Auchan, Żabka | 🛒 Groceries |
| Orlen, BP, Shell | ⛽ Fuel |
| MPK, Uber, Bolt | 🚌 Transport |
| YouTube, Spotify, Netflix, HBO | 📺 Subscriptions |
| Allegro, Amazon, Morele | 🛍️ Shopping |
| Trychodiet, Super-Pharm | 💇 Personal Care |

## Technologie
- Vanilla HTML/JS (bez frameworków)
- LocalStorage do przechowywania dat ostatnich importów
- Client-side CSV parsing
