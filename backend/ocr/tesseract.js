const { execFile } = require('child_process');
const path = require('path');
const util = require('util');
const execFilePromise = util.promisify(execFile);

/**
 * Run Tesseract OCR on an image file and return the extracted text.
 * @param {string} imagePath - Absolute path to the image file.
 * @param {Object} options - Optional Tesseract options.
 * @param {string} options.psm - Page segmentation mode (default: 6).
 * @param {string} options.lang - Languages (default: eng+pol).
 * @returns {Promise<string>} - Extracted text.
 */
async function runOCR(imagePath, options = {}) {
  const psm = options.psm || '6';
  const lang = options.lang || 'eng+pol';

  const args = [path.resolve(imagePath), 'stdout', '--psm', psm, '-l', lang];

  try {
    const { stdout, stderr } = await execFilePromise('tesseract', args, {
      maxBuffer: 1024 * 1024 * 10, // 10MB
      timeout: 60000
    });

    if (stderr) {
      console.warn('[OCR STDERR]', stderr);
    }

    return stdout || '';
  } catch (error) {
    console.error('OCR failed for', imagePath, error.message);
    throw new Error(`OCR failed: ${error.message}`);
  }
}

module.exports = {
  runOCR
};
