import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';

import { analyzeChart as analyzeWithChatGPT } from '../services/chatgpt.js';
import { analyzeChart as analyzeWithGemini }  from '../services/gemini.js';
import { analyzeChartWithOpenRouter }          from '../services/openrouter.js';
import { getBitcoinMarketContext, btcCache }   from '../services/marketData.js';
import { extractChartText }                   from '../services/ocr.js';
import { preprocessChartImage }               from '../services/preprocess.js';
import { addCodexAnalyst }                    from '../services/codexAnalyst.js';

const router = express.Router();
const MAX_FILE_SIZE_MB  = Number(process.env.MAX_UPLOAD_MB    || 8);
const BTC_FETCH_BUDGET_MS = Number(process.env.BTC_FETCH_BUDGET_MS || 15_000);
const allowedMimeTypes  = new Set(['image/png', 'image/jpeg', 'image/webp']);

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

function withBudget(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[analyze] BTC budget (${ms}ms) exceeded — proceeding without market context`);
      resolve({ timedOut: true });
    }, ms);
    promise
      .then(value => { clearTimeout(timer); resolve({ value }); })
      .catch(err  => { clearTimeout(timer); console.error('[analyze] BTC fetch error:', err.message); resolve({ timedOut: true }); });
  });
}

// ── AI provider chain: GPT → Gemini → OpenRouter ──────────────────────────────
async function runAIAnalysis(imagePath, extraData) {
  // 1️⃣ GPT primary
  if (process.env.OPENAI_API_KEY) {
    try {
      const result = await analyzeWithChatGPT(imagePath, extraData);
      result.provider = 'ChatGPT (GPT-4o)';
      console.log('[analyze] ChatGPT analysis ✓');
      return result;
    } catch (err) {
      console.error('[analyze] ChatGPT failed:', err.publicMessage || err.message);
    }
  }

  // 2️⃣ Gemini fallback
  if (process.env.GEMINI_API_KEY) {
    try {
      const result = await analyzeWithGemini(imagePath, extraData);
      result.provider = 'Gemini';
      console.log('[analyze] Gemini analysis ✓');
      return result;
    } catch (err) {
      console.error('[analyze] Gemini failed:', err.publicMessage || err.message);
    }
  }

  // 3️⃣ OpenRouter last resort
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const result = await analyzeChartWithOpenRouter(imagePath, extraData);
      result.provider = result.provider || 'OpenRouter';
      console.log('[analyze] OpenRouter analysis ✓');
      return result;
    } catch (err) {
      console.error('[analyze] OpenRouter failed:', err.publicMessage || err.message);
    }
  }

  throw Object.assign(new Error('All AI providers failed.'), {
    statusCode: 503,
    publicMessage: 'All AI providers are currently unavailable. Please retry in a moment.',
  });
}

function createFallbackAnalysis({ ocrText, marketContext, reason }) {
  return addCodexAnalyst({
    trend: 'neutral',
    marketStructure: 'AI vision analysis temporarily unavailable.',
    marketStructureDetail: { pattern: 'Not available', bos: 'Not visible', choch: 'Not visible', orderBlocks: [], fairValueGaps: [], liquidityZones: [] },
    support: [], resistance: [], psychologicalLevels: [],
    rsi: null, macd: 'Not confirmed', stochRsi: 'Not visible',
    candlePattern: 'Not visible',
    movingAverages: { ma20: 'Not visible', ma50: 'Not visible', ma100: 'Not visible', ma200: 'Not visible', alignment: 'Not visible', crossovers: 'Not visible' },
    tradeSetup: {
      direction: 'NO TRADE', entry: null, stopLoss: null,
      takeProfit1: null, takeProfit2: null, takeProfit3: null,
      riskReward: null, invalidation: 'Wait for full AI analysis before taking any setup.',
      timeframeBias: 'Not visible',
    },
    probability: { bullish: null, bearish: null, sideways: null, confidence: 15 },
    confidence: 15,
    volumeAnalysis: 'Not confirmed', volumeDivergence: 'Not visible',
    openInterest: 'Not visible', fundingRate: 'Not visible',
    scenarioAnalysis: { bullCase: 'Not available', bearCase: 'Not available', baseCase: 'Not available' },
    warnings: [reason || 'AI providers are temporarily unavailable.', 'No trade should be taken from fallback mode.'],
    summary: 'ChartMind processed the upload but AI providers could not complete visual chart reasoning. Please retry shortly.',
    keyObservations: [
      ocrText ? 'OCR extracted chart text.' : 'OCR did not extract enough chart text.',
      `BTC market regime: ${marketContext?.trend || 'unknown'}.`,
    ],
    indicators: {},
    metadata: { pair: 'Not confirmed', timeframe: 'Not confirmed', exchange: 'Not confirmed', currentPrice: 'Not confirmed' },
    btcContext: marketContext?.note || 'BTC context available but AI chart reasoning unavailable.',
    provider: 'Fallback (no AI)',
    degraded: true,
  }, { ocrText, marketContext });
}

router.post('/', async (req, res) => {
  const filesToClean = [];
  let ocrText = '';
  let marketContext = null;

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

    const [processed, btcResult] = await Promise.all([
      preprocessChartImage(req.file.path),
      btcFetchPromise,
    ]);

    filesToClean.push(processed.analysisPath, processed.ocrPath);

    ocrText       = await extractChartText(processed.ocrPath);
    marketContext = btcResult.timedOut ? null : btcResult.value;

    if (marketContext) {
      console.log(`[analyze] BTC ready — source: ${marketContext.source}, trend: ${marketContext.trend}`);
    } else {
      console.warn('[analyze] Proceeding without BTC context');
    }

    const analysis = addCodexAnalyst(
      await runAIAnalysis(processed.analysisPath, {
        mimeType: processed.mimeType,
        ocrText,
        marketContext,
        originalImage: processed.metadata,
      }),
      { ocrText, marketContext }
    );

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
