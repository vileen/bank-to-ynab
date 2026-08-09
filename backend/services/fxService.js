const axios = require('axios');

const NBP_BASE_URL = 'http://api.nbp.pl/api/exchangerates/rates';

/**
 * Pobiera kurs średni NBP dla danej waluty i daty.
 * Jeśli brak kursu na podany dzień, próbuje pobrać z poprzednich 10 dni roboczych.
 * @param {string} currency - Kod waluty (EUR, USD, CHF, GBP...).
 * @param {string} date - Data w formacie YYYY-MM-DD.
 * @param {'A'|'B'} table - Tabela NBP (domyślnie A dla średnich kursów walut).
 * @returns {Promise<number|null>} - Kurs wymiany lub null jeśli nie znaleziono.
 */
async function getRateForDate(currency, date, table = 'A') {
  if (!currency || !date) return null;

  const upperCurrency = currency.toUpperCase();
  if (upperCurrency === 'PLN') return 1;

  // Próbujemy pobrać kurs dla podanej daty, a potem cofamy się max 10 dni
  let currentDate = new Date(date);
  for (let i = 0; i < 10; i++) {
    const dateStr = currentDate.toISOString().split('T')[0];
    try {
      const url = `${NBP_BASE_URL}/${table}/${upperCurrency}/${dateStr}/?format=json`;
      const response = await axios.get(url, { timeout: 10000 });
      const rate = response?.data?.rates?.[0]?.mid;
      if (rate) {
        return parseFloat(rate);
      }
    } catch (error) {
      // Brak kursu na ten dzień - kontynuujemy do tyłu
      if (error.response?.status !== 404) {
        console.warn(`NBP rate fetch failed for ${upperCurrency} ${dateStr}:`, error.message);
      }
    }
    currentDate.setDate(currentDate.getDate() - 1);
  }

  console.warn(`NBP rate not found for ${upperCurrency} near ${date}`);
  return null;
}

/**
 * Konwertuje kwotę w walucie obcej na PLN używając kursu NBP.
 * @param {number} amount - Kwota w walucie źródłowej.
 * @param {string} currency - Kod waluty źródłowej.
 * @param {string} date - Data w formacie YYYY-MM-DD.
 * @returns {Promise<number|null>} - Kwota w PLN lub null.
 */
async function convertToPLN(amount, currency, date) {
  if (!amount || !currency || !date) return null;
  if (currency.toUpperCase() === 'PLN') return parseFloat(amount);

  const rate = await getRateForDate(currency, date);
  if (rate === null) return null;

  return parseFloat(amount) * rate;
}

/**
 * Pobiera kurs NBP dla dnia poprzedniego względem podanej daty.
 * Używane do konwersji cashbacku EUR.
 * @param {string} currency - Kod waluty.
 * @param {string} date - Data transakcji w formacie YYYY-MM-DD.
 * @returns {Promise<number|null>} - Kurs z dnia poprzedniego.
 */
async function getPreviousDayRate(currency, date) {
  if (!currency || !date) return null;
  const prevDate = new Date(date);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevDateStr = prevDate.toISOString().split('T')[0];
  return getRateForDate(currency, prevDateStr);
}

module.exports = {
  getRateForDate,
  convertToPLN,
  getPreviousDayRate
};
