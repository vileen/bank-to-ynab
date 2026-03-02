# Santander → YNAB Importer

Web UI do importu transakcji z Santander do YNAB z auto-kategoryzacją.

## Features
- 📁 Upload CSV (drag & drop)
- 📅 Pamięta datę ostatniego importu (localStorage)
- 🏷️ Auto-kategorie (Lidl, Allegro, Spotify, etc.)
- 🔍 Filtry (tylko nowe / tylko wydatki / kategoria)
- 📊 Podsumowanie wydatków
- 📥 Eksport CSV gotowy do YNAB

## Deploy na GitHub Pages

### 1. Stwórz repo na GitHub
```bash
# Utwórz nowe repo "santander-to-ynab" na GitHub.com
```

### 2. Wypushuj kod
```bash
cd ~/santander-to-ynab
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/vileen/santander-to-ynab.git
git push -u origin main
```

### 3. Włącz GitHub Pages
- Wejdź w repo → Settings → Pages
- Source: Deploy from a branch
- Branch: main / (root)
- Save

### 4. Gotowe!
Appka będzie dostępna pod:
`https://vileen.github.io/santander-to-ynab`

## Password
Jeśli chcesz dodać auth (opcjonalnie), hasło to:
**`f09e8b8a8fc1`**

## Usage
1. Wejdź na stronę
2. Wrzuć CSV z Santander
3. Zobacz podsumowanie
4. Kliknij "Eksportuj do YNAB CSV"
5. Import w YNAB → gotowe!
