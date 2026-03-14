# Bank CSV → YNAB Importer

Web UI do importu transakcji z polskich banków do YNAB z auto-kategoryzacją i integracją API.

## Architektura

```
┌─────────────┐      ┌─────────────────┐      ┌─────────────┐
│   Frontend  │ ←──→ │    Backend      │ ←──→ │  YNAB API   │
│  (GitHub    │      │  (Node.js)      │      │             │
│   Pages)    │      │  (localhost)    │      │             │
└─────────────┘      └─────────────────┘      └─────────────┘
```

## Features

### Frontend
- 🏛️ **Wybór banku** — parsery dla różnych formatów CSV
- 📁 Upload CSV (drag & drop)
- 🏷️ Auto-kategorie na podstawie mapowań
- 📊 Podsumowanie wydatków
- 🔍 Filtry (tylko wydatki / kategoria)
- 🔗 **Integracja z YNAB API** — pobieranie kategorii i kont
- 🔗 **Mapowania kategorii** — twórz własne reguły

### Backend
- 🔐 **Klucz API w .env** — bezpieczne przechowywanie
- 📡 **Proxy do YNAB API** — pobieranie budgetów, kategorii, kont
- 💾 **Storage mapowań** — JSON file storage
- 🔄 **Auto-kategoryzacja** — na podstawie zapisanych reguł

## Szybki start

### 1. Uruchom backend

```bash
cd backend
npm install
npm start
```

Backend uruchomi się na `http://localhost:3001`

### 2. Skonfiguruj YNAB API Key

W pliku `backend/.env`:
```env
YNAB_API_KEY=twój_personal_access_token
```

[Jak uzyskać YNAB Personal Access Token](https://api.youneedabudget.com/#personal-access-tokens)

### 3. Uruchom frontend

Frontend to statyczny HTML — możesz otworzyć bezpośrednio:
```bash
# Opcja 1: Otwórz plik w przeglądarce
open index.html

# Opcja 2: Użyj prostego serwera
npx serve . -p 8080
```

### 4. Użyj aplikacji

1. Wybierz budget YNAB
2. Wybierz konto docelowe
3. Wgraj plik CSV z banku
4. Kategorie zostaną automatycznie przypisane (jeśli masz mapowania)
5. Eksportuj transakcje bezpośrednio do YNAB

## Obsługiwane banki

| Bank | Status | Uwagi |
|------|--------|-------|
| 🇵🇱 **Santander Polska** | ✅ Gotowe | Karta kredytowa, eksport CSV |
| 🇵🇱 mBank | 🚧 Planowane | - |
| 🇵🇱 ING | 🚧 Planowane | - |
| 🇵🇱 PKO BP | 🚧 Planowane | - |

## Mapowania kategorii

Przejdź do zakładki **"Mapowania"** aby utworzyć powiązania:

| Słowo kluczowe | Kategoria YNAB |
|----------------|----------------|
| lidl | 🛒 Groceries |
| allegro | 🛍️ Shopping |
| youtube | 📺 Subscriptions |
| orlen | ⛽ Fuel |
| mpk | 🚌 Transport |

Przy imporcie CSV aplikacja automatycznie przypisze kategorie na podstawie tych reguł.

## API Endpoints

### YNAB Proxy
- `GET /api/budgets` — lista budgetów
- `GET /api/budgets/:id/categories` — kategorie
- `GET /api/budgets/:id/accounts` — konta
- `POST /api/budgets/:id/transactions` — tworzenie transakcji

### Mapowania
- `GET /api/mappings` — lista mapowań
- `POST /api/mappings` — dodaj mapowanie
- `DELETE /api/mappings/:keyword` — usuń mapowanie

### Health
- `GET /api/health` — status połączenia

## Deploy

### Frontend (GitHub Pages)
```bash
git add .
git commit -m "Update frontend"
git push origin main
```

GitHub Pages automatycznie zdeployuje zmiany.

### Backend (lokalny VPS / VPS)
```bash
# Przykład z PM2
pm2 start backend/server.js --name bank-to-ynab
```

**Ważne:** Nigdy nie commituj `backend/.env` z prawdziwym kluczem API!

## Technologie

- **Frontend:** Vanilla HTML/JS, CSS Grid/Flexbox
- **Backend:** Node.js, Express, Axios
- **Storage:** JSON files (można zamienić na SQLite/PostgreSQL)

## Roadmap

- [x] Parser Santander CSV
- [x] Integracja z YNAB API
- [x] Mapowania kategorii
- [x] Auto-kategoryzacja
- [ ] Wsparcie dla więcej banków (mBank, ING, PKO)
- [ ] Historia importów
- [ ] Wykresy statystyk
- [ ] Import bezpośrednio z banku (PSD2 API)
