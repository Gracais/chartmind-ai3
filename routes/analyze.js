import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';

import { analyzeChart }                    from '../services/gemini.js';
import { analyzeChartWithOpenRouter }      from '../services/openrouter.js';
import { getBitcoinMarketContext, btcCache } from '../services/marketData.js';
import { extractChartText }                from '../services/ocr.js';
import { preprocessChartImage }            from '../services/preprocess.js';

const router = express.Router();
const MAX_FILE_SIZE_MB = Number(process.env.MAX_UPLOAD_MB || 8);
const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

// How long to wait for BTC market data before proceeding without it.
// Kept high for Render cold-start — but cached responses are instant.
const BTC_FETCH_BUDGET_MS = Number(process.env.BTC_FETCH_BUDGET_MS || 15_000);

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: 1 },
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

// Resolves with { value } or { timedOut: true } — never rejects.
function withBudget(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[analyze] BTC budget (${ms}ms) exceeded — proceeding without market context`);
      resolve({ timedOut: true });
    }, ms);
    promise
      .then((value) => { clearTimeout(timer); resolve({ value }); })
      .catch((err)  => { clearTimeout(timer); console.error('[analyze] BTC fetch error:', err.message); resolve({ timedOut: true }); });
  });
}

// ── AI provider chain: Gemini → OpenRouter ────────────────────────────────
async function runAIAnalysis(imagePath, extraData) {
  // 1. Try Gemini (primary)
  try {
    const result = await analyzeChart(imagePath, extraData);
    console.log('[analyze] AI provider: Gemini ✓');
    return result;
  } catch (geminiErr) {
    console.error('[analyze] Gemini failed:', geminiErr.publicMessage || geminiErr.message);

    // Only fall through to OpenRouter if Gemini failed due to rate limit / overload / timeout
    const isRetryable = geminiErr.retryable !== false;
    const isTransient  = geminiErr.statusCode === 503 || geminiErr.statusCode === 429 || geminiErr.statusCode === 504 || geminiErr.statusCode === 502;

    if (!isRetryable && !isTransient) throw geminiErr;

    // 2. Try OpenRouter (fallback)
    try {
      console.log('[analyze] Falling back to OpenRouter...');
      const result = await analyzeChartWithOpenRouter(imagePath, extraData);
      console.log('[analyze] AI provider: OpenRouter ✓');
      return result;
    } catch (orErr) {
      console.error('[analyze] OpenRouter also failed:', orErr.message);
      // Re-throw original Gemini error (more meaningful to caller)
      throw geminiErr;
    }
  }
}

function createFallbackAnalysis({ ocrText, marketContext, reason }) {
  return {
    trend: 'neutral',
    marketStructure: 'AI vision analysis temporarily unavailable.',
    support: [], resistance: [],
    rsi: null, macd: 'Not confirmed',
    tradeSetup: {
      direction: 'NO TRADE', entry: null, stopLoss: null, takeProfit: null, riskReward: null,
      invalidation: 'Wait for full AI chart analysis before taking a setup.',
    },
    confidence: 15,
    warnings: [
      reason || 'Both AI providers unavailable. This is a fallback report.',
      'No trade should be taken from fallback mode alone.',
    ],
    summary: 'ChartMind processed the upload and market context, but both AI providers (Gemini + OpenRouter) could not complete visual chart reasoning. Please retry shortly.',
    keyObservations: [
      ocrText ? 'OCR extracted chart text for the next full analysis attempt.' : 'OCR did not extract enough chart text.',
      `BTC market regime context is ${marketContext?.trend || 'unknown'}.`,
    ],
    indicators: {},
    volumeAnalysis: 'Not confirmed without full AI analysis.',
    metadata: { pair: 'Not confirmed', timeframe: 'Not confirmed', exchange: 'Not confirmed', currentPrice: 'Not confirmed' },
    btcContext: marketContext?.note || 'BTC context available but AI chart reasoning unavailable.',
    provider: 'Fallback (no AI)',
    degraded: true,
  };
}

router.post('/', async (req, res) => {
  const filesToClean = [];
  let ocrText = '';
  let marketContext = null;

  // ── Kick off BTC fetch immediately on request arrival.
  // If a recent cached result exists it resolves in <1ms.
  const btcFetchPromise = withBudget(
    getBitcoinMarketContext(),
    btcCache.fresh() ? 500 : BTC_FETCH_BUDGET_MS,
  );

  try {
    await multerMiddleware(req, res);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_IMAGE', message: 'Upload a chart screenshot before running analysis.' },
      });
    }

    filesToClean.push(req.file.path);

    // Preprocess + OCR + BTC all race in parallel
    const [processed, btcResult] = await Promise.all([
      preprocessChartImage(req.file.path),
      btcFetchPromise,
    ]);

    filesToClean.push(processed.analysisPath, processed.ocrPath);

    // OCR runs on already-preprocessed file; BTC may already be done
    ocrText = await extractChartText(processed.ocrPath);
    marketContext = btcResult.timedOut ? null : btcResult.value;

    if (marketContext) {
      console.log(`[analyze] BTC ready — source: ${marketContext.source}, trend: ${marketContext.trend}`);
    } else {
      console.warn('[analyze] Proceeding without BTC context');
    }

    const analysis = await runAIAnalysis(processed.analysisPath, {
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
          resized: true, contrastEnhanced: true, ocrOptimized: true, compressed: true,
          original: processed.metadata,
        },
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('[analyze]', error);

    if (status === 503 && (ocrText || marketContext)) {
      return res.status(200).json({
        success: true,
        data: {
          analysis: createFallbackAnalysis({ ocrText, marketContext, reason: error.publicMessage || error.message }),
          ocrText, marketContext,
          preprocessing: { resized: true, contrastEnhanced: true, ocrOptimized: true, compressed: true, degraded: true },
        },
      });
    }

    return res.status(status).json({
      success: false,
      error: {
        code: status >= 500 ? 'ANALYSIS_FAILED' : 'INVALID_UPLOAD',
        message: error.publicMessage || (status >= 500
          ? 'ChartMind could not complete analysis right now. Please retry.'
          : error.message),
        detail: process.env.NODE_ENV === 'production' ? undefined : error.message,
      },
    });
  } finally {
    await Promise.all(filesToClean.map(removeQuietly));
    try { await fs.mkdir(path.resolve('uploads'), { recursive: true }); } catch {}
  }
});

export default router;
