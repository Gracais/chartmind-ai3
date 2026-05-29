import Tesseract from 'tesseract.js';

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(Object.assign(new Error('OCR timed out while reading the chart.'), { code: 'OCR_TIMEOUT' }));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export async function extractChartText(imagePath, { timeoutMs = 25_000 } = {}) {
  try {
    const result = await withTimeout(
      Tesseract.recognize(imagePath, 'eng', {
        tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
      }),
      timeoutMs
    );
    return String(result.data.text || '').trim();
  } catch (error) {
    console.error('OCR Error:', error.message);
    if (error.code === 'OCR_TIMEOUT') {
      throw Object.assign(error, { statusCode: 504 });
    }
    return '';
  }
}
