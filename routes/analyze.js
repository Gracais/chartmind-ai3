import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';

import { analyzeChart } from '../services/gemini.js';
import { getBitcoinMarketContext } from '../services/marketData.js';
import { extractChartText } from '../services/ocr.js';
import { preprocessChartImage } from '../services/preprocess.js';

const router = express.Router();
const MAX_FILE_SIZE_MB = Number(process.env.MAX_UPLOAD_MB || 8);
const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

// How long to wait for BTC market data before giving up and proceeding without it.
// Set high so Render's slow cold-start network has time to complete.
const BTC_FETCH_BUDGET_MS = Number(process.env.BTC_FETCH_BUDGET_MS || 55_000);

const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      cb(Object.assign(new Error('Upload a PNG, JPG, or WEBP chart screenshot.'), { statusCode: 415 }));
      return;
    }
    cb(null, true);
  },
});

async function removeQuietly(filePath) {
  if (!filePath) return;
  try { await fs.unlink(filePath); } catch {}
}

function multerMiddleware(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('image')(req, res, (error) => {
      if (!error) return resolve();
      if (error.code === 'LIMIT_FILE_SIZE') {
        return reject(Object.assign(new Error(`Image must be ${MAX_FILE_SIZE_MB}MB or smaller.`), { statusCode: 413 }));
      }
      reject(error);
    });
  });
}

// Wraps a promise with a wall-clock deadline.
// Resolves with { value } on success, { timedOut: true } on timeout — never rejects.
function withBudget(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[analyze] BTC fetch budget (${ms}ms) exceeded — proceeding without market context`);
      resolve({ timedOut: true });
    }, ms);
    promise
      .then((value) => { clearTimeout(timer); resolve({ value }); })
      .catch((err)  => { clearTimeout(timer); console.error('[analyze] BTC fetch error:', err.message); resolve({ timedOut: true }); });
  });
}

function createFallbackAnalysis({ ocrText, marketContext, reason }) {
  return {
    trend: 'neutral',
    marketStructure: 'AI vision analysis is temporarily unavailable, so no chart structure is confirmed.',
    support: [],
    resistance: [],
    rsi: null,
    macd: 'Not confirmed',
    tradeSetup: {
      direction: 'NO TRADE',
      entry: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      invalidation: 'Wait for full AI chart analysis before taking a setup.',
    },
    confidence: 15,
    warnings: [
      reason || 'AI provider unavailable. This is a fallback report, not a full chart read.',
      'No trade should be taken from fallback mode alone.',
    ],
    summary: 'ChartMind processed the upload and market context, but the AI provider could not complete visual chart reasoning. Retry once Gemini quota or availability is restored.',
    keyObservations: [
      ocrText ? 'OCR extracted chart text for the next full analysis attempt.' : 'OCR did not extract enough chart text from this image.',
      `BTC market regime context is ${marketContext?.trend || 'unknown'}.`,
    ],
    indicators: {},
    volumeAnalysis: 'Not confirmed without full AI chart analysis.',
    metadata: {
      pair: 'Not confirmed',
      timeframe: 'Not confirmed',
      exchange: 'Not confirmed',
      currentPrice: 'Not confirmed',
    },
    btcContext: marketContext?.note || 'BTC context is available but full AI chart reasoning is unavailable.',
    degraded: true,
  };
}

router.post('/', async (req, res) => {
  const filesToClean = [];
  let ocrText = '';
  let marketContext = null;

  // ── Kick off BTC fetch IMMEDIATELY on request arrival, before anything else.
  // This gives it the maximum possible time while the image is being processed.
  const btcFetchPromise = withBudget(getBitcoinMarketContext(), BTC_FETCH_BUDGET_MS);

  try {
    await multerMiddleware(req, res);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_IMAGE', message: 'Upload a chart screenshot before running analysis.' },
      });
    }

    filesToClean.push(req.file.path);

    // Preprocess image + OCR in parallel while BTC fetch is already running in background
    const processed = await preprocessChartImage(req.file.path);
    filesToClean.push(processed.analysisPath, processed.ocrPath);

    // Wait for OCR and BTC fetch together (BTC fetch may already be done by now)
    const [ocrResult, btcResult] = await Promise.all([
      extractChartText(processed.ocrPath),
      btcFetchPromise,
    ]);

    ocrText = ocrResult;
    marketContext = btcResult.timedOut ? null : btcResult.value;

    if (marketContext) {
      console.log(`[analyze] BTC context ready — source: ${marketContext.source}, trend: ${marketContext.trend}`);
    } else {
      console.warn('[analyze] Proceeding without BTC context (timed out or failed)');
    }

    const analysis = await analyzeChart(processed.analysisPath, {
      mimeType: processed.mimeType,
      ocrText,
      marketContext,
      originalImage: processed.metadata,
    });

    return res.json({
      success: true,
      data: {
        analysis,
        ocrText,
        marketContext,
        preprocessing: {
          resized: true,
          contrastEnhanced: true,
          ocrOptimized: true,
          compressed: true,
          original: processed.metadata,
        },
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) {
      console.error('[analyze]', error);
    }

    if (status === 503 && (ocrText || marketContext)) {
      return res.status(200).json({
        success: true,
        data: {
          analysis: createFallbackAnalysis({
            ocrText,
            marketContext,
            reason: error.publicMessage || error.message,
          }),
          ocrText,
          marketContext,
          preprocessing: { resized: true, contrastEnhanced: true, ocrOptimized: true, compressed: true, degraded: true },
        },
      });
    }

    return res.status(status).json({
      success: false,
      error: {
        code: status >= 500 ? 'ANALYSIS_FAILED' : 'INVALID_UPLOAD',
        message: error.publicMessage || (status >= 500
          ? 'ChartMind could not complete the AI analysis right now. Please retry in a moment.'
          : error.message),
        detail: process.env.NODE_ENV === 'production' ? undefined : error.message,
      },
    });
  } finally {
    await Promise.all(filesToClean.map(removeQuietly));
    try {
      await fs.mkdir(path.resolve('uploads'), { recursive: true });
    } catch {}
  }
});

export default router;
