// OpenRouter fallback — free tier models that support vision
// Used when Gemini quota/rate-limits are hit
import fs from 'fs/promises';
import fetch from 'node-fetch';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE    = 'https://openrouter.ai/api/v1';
const OPENROUTER_TIMEOUT = Number(process.env.OPENROUTER_TIMEOUT_MS || 40_000);

// Vision-capable free models on OpenRouter (in priority order)
// Update this list at: https://openrouter.ai/models?q=free&modality=image
const FREE_VISION_MODELS = (
  process.env.OPENROUTER_MODELS ||
  'google/gemini-2.0-flash-exp:free,meta-llama/llama-4-maverick:free,mistralai/mistral-small-3.2-24b-instruct:free'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw Object.assign(new Error('OpenRouter: response was not valid JSON.'), {
      statusCode: 502,
      publicMessage: 'The fallback AI provider returned unstructured output. Please retry.',
      retryable: true,
    });
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('OpenRouter: malformed JSON in response.'), {
      statusCode: 502,
      publicMessage: 'The fallback AI returned malformed JSON. Please retry.',
      retryable: true,
    });
  }
}

function toNumber(value, fallback = null) {
  const parsed = Number(String(value ?? '').replace(/[,$]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item?.price ?? item).trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function normalizeAnalysis(raw) {
  const setup    = raw.tradeSetup || {};
  const metadata = raw.metadata  || {};
  const entry     = toNumber(setup.entry);
  const stopLoss  = toNumber(setup.stopLoss);
  const takeProfit = toNumber(setup.takeProfit ?? setup.target1 ?? setup.target);
  const riskReward = toNumber(setup.riskReward);

  return {
    trend: String(raw.trend || 'neutral').toLowerCase(),
    marketStructure: raw.marketStructure || 'Not visible',
    support:    normalizeArray(raw.support    || raw.supportLevels),
    resistance: normalizeArray(raw.resistance || raw.resistanceLevels),
    rsi:  toNumber(raw.rsi ?? raw.indicators?.rsi),
    macd: String(raw.macd || raw.indicators?.macd || 'Not visible'),
    tradeSetup: {
      direction:   String(setup.direction || setup.bias || 'NO TRADE').toUpperCase(),
      entry, stopLoss, takeProfit, riskReward,
      invalidation: setup.invalidation || setup.validity || 'Not visible',
    },
    confidence: Math.max(0, Math.min(100, toNumber(raw.confidence ?? raw.confidenceScore, 0))),
    warnings:        normalizeArray(raw.warnings || raw.warning),
    summary:         raw.summary || 'No summary generated.',
    keyObservations: normalizeArray(raw.keyObservations || raw.observations),
    indicators:      raw.indicators || {},
    volumeAnalysis:  raw.volumeAnalysis || 'Not visible',
    metadata: {
      pair:         metadata.pair      || raw.pair      || raw.coin     || 'Not visible',
      timeframe:    metadata.timeframe || raw.timeframe || 'Not visible',
      exchange:     metadata.exchange  || raw.exchange  || 'Not visible',
      currentPrice: metadata.currentPrice || raw.currentPrice || 'Not visible',
    },
    btcContext:  raw.btcContext || raw.marketContext || null,
    provider:   'OpenRouter (fallback)',
    futureHooks: {
      telegramAlerts: false, discordIntegration: false, liveMarketData: false,
      tradingViewIntegration: false, voiceAnalysis: false, screenshotAnnotations: false,
      aiTradingMemory: false, tradeJournal: false, accountDashboards: false,
    },
  };
}

async function requestOpenRouter({ model, base64Image, mimeType, prompt, signal }) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type':  'application/json',
      Authorization:   `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer':  'https://chartmind-ai.onrender.com',
      'X-Title':       'ChartMind AI',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1800,
      temperature: 0.12,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${base64Image}` },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message || `OpenRouter ${model} failed: ${res.status}`;
    const err = Object.assign(new Error(msg), {
      statusCode: res.status >= 500 ? 502 : res.status,
      publicMessage: 'Fallback AI provider is temporarily unavailable. Please retry.',
      retryable: res.status >= 500 || res.status === 429,
    });
    throw err;
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw Object.assign(new Error('OpenRouter returned an empty response.'), {
      statusCode: 502,
      publicMessage: 'Fallback AI returned an empty response. Please retry.',
      retryable: true,
    });
  }

  return normalizeAnalysis(extractJson(text));
}

export async function analyzeChartWithOpenRouter(imagePath, extraData = {}) {
  if (!OPENROUTER_API_KEY) {
    throw Object.assign(new Error('OpenRouter API key not configured.'), {
      statusCode: 503,
      publicMessage: 'Fallback AI provider not configured.',
      retryable: false,
    });
  }

  const base64Image = await fs.readFile(imagePath, 'base64');

  const prompt = `You are ChartMind AI, a professional institutional trading analyst.

Analyze only what is visible in the chart screenshot. Do not invent indicators,
prices, timeframes, or patterns that cannot be inferred from the image or OCR.

Return ONLY valid JSON matching this schema exactly (no markdown, no preamble):
{
  "trend": "bullish | bearish | neutral",
  "marketStructure": "institutional market structure read",
  "support": ["102400"],
  "resistance": ["104900"],
  "rsi": 68,
  "macd": "bullish crossover",
  "tradeSetup": {
    "direction": "BUY | SELL | NO TRADE",
    "entry": 103500,
    "stopLoss": 102200,
    "takeProfit": 106800,
    "riskReward": 2.54,
    "invalidation": "what invalidates the setup"
  },
  "confidence": 87,
  "warnings": ["Possible fake breakout if volume weakens"],
  "summary": "3-5 sentence professional analysis",
  "keyObservations": ["observation"],
  "indicators": {
    "rsi": "reading and interpretation",
    "macd": "reading and interpretation",
    "movingAverages": "if visible",
    "volume": "if visible"
  },
  "volumeAnalysis": "volume read",
  "btcContext": "how live BTC trend affects this setup",
  "metadata": {
    "pair": "BTC/USDT or Not visible",
    "timeframe": "4H or Not visible",
    "exchange": "Binance or Not visible",
    "currentPrice": "visible price or Not visible"
  }
}

OCR/chart context:
${JSON.stringify({
  ocrText: extraData.ocrText || 'No OCR text extracted.',
  btcMarketContext: extraData.marketContext || {},
  originalImage: extraData.originalImage || {},
}, null, 2)}`;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT);

  try {
    let lastError;
    for (const model of FREE_VISION_MODELS) {
      try {
        console.log(`[openrouter] Trying model: ${model}`);
        const result = await requestOpenRouter({
          model, base64Image, mimeType: extraData.mimeType, prompt, signal: controller.signal,
        });
        console.log(`[openrouter] Success with model: ${model}`);
        return result;
      } catch (err) {
        lastError = err;
        console.error(`[openrouter:${model}]`, err.message);
        if (!err.retryable) break;
      }
    }
    throw lastError;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('OpenRouter fallback timed out.'), { statusCode: 504, retryable: false });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
