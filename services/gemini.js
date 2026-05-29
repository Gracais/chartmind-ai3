import fs from 'fs/promises';
import fetch from 'node-fetch';

const GEMINI_MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-flash-latest,gemini-2.0-flash-lite')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 35_000);

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    run: () => promise(controller.signal).finally(() => clearTimeout(timeoutId)),
  };
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw Object.assign(new Error('AI response was not valid structured JSON.'), {
      statusCode: 502,
      publicMessage: 'The AI provider returned unstructured output. Your image uploaded correctly; retry the analysis.',
      retryable: true,
    });
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('AI response JSON was malformed.'), {
      statusCode: 502,
      publicMessage: 'The AI provider returned malformed JSON. Your image uploaded correctly; retry the analysis.',
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
  const setup = raw.tradeSetup || {};
  const metadata = raw.metadata || {};
  const entry = toNumber(setup.entry);
  const stopLoss = toNumber(setup.stopLoss);
  const takeProfit = toNumber(setup.takeProfit ?? setup.target1 ?? setup.target);
  const riskReward = toNumber(setup.riskReward);

  return {
    trend: String(raw.trend || 'neutral').toLowerCase(),
    marketStructure: raw.marketStructure || 'Not visible',
    support: normalizeArray(raw.support || raw.supportLevels),
    resistance: normalizeArray(raw.resistance || raw.resistanceLevels),
    rsi: toNumber(raw.rsi ?? raw.indicators?.rsi),
    macd: String(raw.macd || raw.indicators?.macd || 'Not visible'),
    tradeSetup: {
      direction: String(setup.direction || setup.bias || 'NO TRADE').toUpperCase(),
      entry,
      stopLoss,
      takeProfit,
      riskReward,
      invalidation: setup.invalidation || setup.validity || 'Not visible',
    },
    confidence: Math.max(0, Math.min(100, toNumber(raw.confidence ?? raw.confidenceScore, 0))),
    warnings: normalizeArray(raw.warnings || raw.warning),
    summary: raw.summary || 'No summary generated.',
    keyObservations: normalizeArray(raw.keyObservations || raw.observations),
    indicators: raw.indicators || {},
    volumeAnalysis: raw.volumeAnalysis || 'Not visible',
    metadata: {
      pair: metadata.pair || raw.pair || raw.coin || 'Not visible',
      timeframe: metadata.timeframe || raw.timeframe || 'Not visible',
      exchange: metadata.exchange || raw.exchange || 'Not visible',
      currentPrice: metadata.currentPrice || raw.currentPrice || 'Not visible',
    },
    btcContext: raw.btcContext || raw.marketContext || null,
    futureHooks: {
      telegramAlerts: false,
      discordIntegration: false,
      liveMarketData: false,
      tradingViewIntegration: false,
      voiceAnalysis: false,
      screenshotAnnotations: false,
      aiTradingMemory: false,
      tradeJournal: false,
      accountDashboards: false,
    },
  };
}

function classifyProviderError(message, statusCode = 502) {
  const text = String(message || '');
  const lower = text.toLowerCase();

  if (lower.includes('quota') || lower.includes('billing') || lower.includes('rate-limit') || lower.includes('rate limit')) {
    return Object.assign(new Error(text), {
      statusCode: 503,
      publicMessage: 'The AI provider rejected the request because Gemini quota or billing is exhausted. The image uploaded correctly.',
      retryable: true,
    });
  }

  if (lower.includes('high demand') || lower.includes('overloaded') || lower.includes('temporarily unavailable') || statusCode === 503 || statusCode === 429) {
    return Object.assign(new Error(text), {
      statusCode: 503,
      publicMessage: 'Gemini is temporarily busy. Your image uploaded correctly; retry in a moment.',
      retryable: true,
    });
  }

  return Object.assign(new Error(text || 'Gemini request failed.'), {
    statusCode: statusCode >= 500 ? 502 : statusCode,
    publicMessage: 'ChartMind could not complete the AI analysis right now. Please retry in a moment.',
    retryable: statusCode >= 500,
  });
}

async function requestGemini({ model, base64Image, extraData, prompt, signal }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.12,
          topP: 0.75,
          maxOutputTokens: 1800,
          responseMimeType: 'application/json',
        },
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: extraData.mimeType || 'image/jpeg',
                data: base64Image,
              },
            },
            { text: prompt },
          ],
        }],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Gemini request failed with status ${response.status}`;
    throw classifyProviderError(message, response.status);
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
  if (!text) {
    throw Object.assign(new Error('Gemini returned an empty analysis.'), {
      statusCode: 502,
      publicMessage: 'Gemini returned an empty analysis. Please retry with a full chart screenshot.',
      retryable: true,
    });
  }

  return normalizeAnalysis(extractJson(text));
}

export async function analyzeChart(imagePath, extraData = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw Object.assign(new Error('Gemini API key is not configured.'), { statusCode: 500 });
  }

  const base64Image = await fs.readFile(imagePath, 'base64');
  const prompt = `
You are ChartMind AI, a professional institutional trading analyst.

Analyze only what is visible in the chart screenshot. Do not invent indicators,
prices, timeframes, or patterns that cannot be inferred from the image or OCR.
Also consider the provided live BTC market regime as broad crypto context:
- If the uploaded chart is BTC, use BTC regime as confirmation/confluence.
- If the uploaded chart is an altcoin, use BTC trend as market beta/risk context.
- Never replace visible chart levels with BTC levels unless the uploaded chart is BTC.

Return ONLY valid JSON matching this schema:
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
}, null, 2)}
`;

  const request = withTimeout(async (signal) => {
    let lastError;
    for (const model of GEMINI_MODELS) {
      try {
        return await requestGemini({ model, base64Image, extraData, prompt, signal });
      } catch (error) {
        lastError = error;
        console.error(`[gemini:${model}]`, error.publicMessage || error.message);
        if (!error.retryable) break;
      }
    }
    throw lastError;
  }, GEMINI_TIMEOUT_MS);

  try {
    return await request.run();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('Gemini analysis timed out. Try a clearer or smaller chart image.'), { statusCode: 504 });
    }
    throw error;
  }
}
