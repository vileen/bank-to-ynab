/**
 * Szybki skrypt testowy do OCR zrzutów ekranu OKX.
 * Użycie: node scripts/test-okx-ocr.js <ścieżka-do-katalogu-ze-screenshotami>
 * Zapisuje raw OCR text do JSON w katalogu uploads/ocr-debug.
 */

const fs = require('fs');
const path = require('path');
const ocr = require('../ocr/tesseract');
const parser = require('../parsers/okxScreenshot');

const inputDir = process.argv[2];
if (!inputDir) {
  console.error('Użycie: node scripts/test-okx-ocr.js <ścieżka-do-katalogu-ze-screenshotami>');
  process.exit(1);
}

const outputDir = path.join(__dirname, '..', 'uploads', 'ocr-debug');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

async function main() {
  const files = fs.readdirSync(inputDir)
    .filter(f => imageExts.has(path.extname(f).toLowerCase()))
    .map(f => path.join(inputDir, f));

  console.log(`Znaleziono ${files.length} plików obrazów.`);

  const results = [];
  for (const file of files) {
    console.log(`OCR: ${path.basename(file)}`);
    try {
      const ocrText = await ocr.runOCR(file, { psm: '6' });
      const parsed = parser.parseOCRText(ocrText);
      results.push({
        filename: path.basename(file),
        ocrText,
        transactions: parsed.transactions,
        confidence: parsed.confidence
      });
    } catch (err) {
      console.error(`Błąd dla ${file}:`, err.message);
      results.push({ filename: path.basename(file), error: err.message });
    }
  }

  const outputPath = path.join(outputDir, `ocr-debug-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nWyniki zapisane do: ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
