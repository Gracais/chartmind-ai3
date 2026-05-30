import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';

import { analyzeChart as analyzeWithChatGPT }   from '../services/chatgpt.js';
import { analyzeChart as analyzeWithClaude }    from '../services/claude.js';
import { getBitcoinMarketContext, btcCache }   from '../services/marketData.js';
import { extractChartText }                    from '../services/ocr.js';
import { preprocessChartImage }                from '../services/preprocess.js';
import { addCodexAnalyst }                     from '../services/codexAnalyst.js';

const router = express.Router();
const MAX_FILE_SIZE_MB = Number(process.env.MAX_UPLOAD_MB || 8);
const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

// How long to wait for BTC market data before proceeding without it.
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

// ── Multi-AI Analysis: ChatGPT (primary) + Claude (secondary) + Codex (audit) ────────────────
async function runAIAnalysis(imagePath, extraData) {
  let chatgptResult = null;
  let claudeResult = null;
  let chatgptError = null;
  let claudeError = null;

  // Run both analyses in parallel
  const [gptRes, claudeRes] = await Promise.all([
    (async () => {
      try {
        chatgptResult = await analyzeWithChatGPT(imagePath, extraData);
        console.log('[analyze] ChatGPT analysis ✓');
        return { success: true };
      } catch (error) {
        chatgptError = error;
        console.error('[analyze] ChatGPT failed:', error.publicMessage || error.message);
        return { success: false };
      }
    })(),
    (async () => {
      try {
        claudeResult = await analyzeWithClaude(imagePath, extraData);
        console.log('[analyze] Claude analysis ✓');
        return { success: true };
      } catch (error) {
        claudeError = error;
        console.error('[analyze] Claude failed:', error.publicMessage || error.message);
        return { success: false };
      }
    })(),
  ]);

  // If ChatGPT succeeded, use it as primary with Claude as secondary opinion
  if (chatgptResult) {
    chatgptResult.secondOpinion = claudeResult || null;
    return chatgptResult;
  }

  // If ChatGPT failed but Claude succeeded, use Claude
  if (claudeResult) {
    claudeResult.provider = 'Claude (ChatGPT unavailable)';
    return claudeResult;
  }

  // Both failed
  throw chatgptError || claudeError || new Error('Both AI providers failed');
}

function createFallbackAnalysis({ ocrText, marketContext, reason }) {
  return addCodexAnalyst({
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
      reason || 'AI providers are temporarily unavailable.',
      'No trade should be taken from fallback mode alone.',
    ],
    summary: 'ChartMind processed the upload and market context, but the AI providers could not complete visual chart reasoning. Please retry shortly.',
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
  }, { ocrText, marketContext });
}

router.post('/', async (req, res) => {
  const filesToClean = [];
  let ocrText = '';
  let marketContext = null;

  // ── Kick off BTC fetch immediately on request arrival.
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

    const analysis = addCodexAnalyst(await runAIAnalysis(processed.analysisPath, {
      mimeType: processed.mimeType,
      ocrText,
      marketContext,
      originalImage: processed.metadata,
    }), { ocrText, marketContext });

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
