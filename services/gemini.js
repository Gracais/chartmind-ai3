import fs from 'fs/promises';
import fetch from 'node-fetch';

const GEMINI_MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite,gemini-2.0-flash-lite')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 45_000);

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    run: () => promise(controller.signal).finally(() => clearTimeout(timeoutId)),
  };
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start   = cleaned.indexOf('{');
  const end     = cleaned.lastIndexOf('}');
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
  const parsed = Number(String(value ?? '').replace(/[,$%]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => String(item?.price ?? item?.level ?? item).trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function normalizeAnalysis(raw) {
  const setup    = raw.tradeSetup || {};
  const metadata = raw.metadata   || {};
  const prob     = raw.probability || {};
  const ms       = raw.marketStructureDetail || {};

  return {
    trend:           String(raw.trend || 'neutral').toLowerCase(),
    marketStructure: raw.marketStructure || 'Not visible',
    marketStructureDetail: {
      pattern:        ms.pattern        || 'Not visible',
      bos:            ms.bos            || 'Not visible',
      choch:          ms.choch          || 'Not visible',
      higherHighs:    ms.higherHighs    ?? null,
      higherLows:     ms.higherLows     ?? null,
      lowerHighs:     ms.lowerHighs     ?? null,
      lowerLows:      ms.lowerLows      ?? null,
      orderBlocks:    normalizeArray(ms.orderBlocks),
      fairValueGaps:  normalizeArray(ms.fairValueGaps),
      liquidityZones: normalizeArray(ms.liquidityZones),
    },
    support:             normalizeArray(raw.support    || raw.supportLevels),
    resistance:          normalizeArray(raw.resistance || raw.resistanceLevels),
    psychologicalLevels: normalizeArray(raw.psychologicalLevels),
    rsi:      toNumber(raw.rsi  ?? raw.indicators?.rsi),
    macd:     String(raw.macd   || raw.indicators?.macd || 'Not visible'),
    stochRsi: raw.stochRsi      || raw.indicators?.stochRsi || 'Not visible',
    movingAverages: {
      ma20:      raw.indicators?.ma20  || raw.movingAverages?.ma20  || 'Not visible',
      ma50:      raw.indicators?.ma50  || raw.movingAverages?.ma50  || 'Not visible',
      ma100:     raw.indicators?.ma100 || raw.movingAverages?.ma100 || 'Not visible',
      ma200:     raw.indicators?.ma200 || raw.movingAverages?.ma200 || 'Not visible',
      alignment:  raw.movingAverages?.alignment  || 'Not visible',
      crossovers: raw.movingAverages?.crossovers || 'Not visible',
    },
    candlePattern: raw.candlePattern || 'Not visible',
    tradeSetup: {
      direction:     String(setup.direction || setup.bias || 'NO TRADE').toUpperCase(),
      entry:         toNumber(setup.entry),
      stopLoss:      toNumber(setup.stopLoss),
      takeProfit1:   toNumber(setup.takeProfit1 ?? setup.takeProfit ?? setup.target1 ?? setup.target),
      takeProfit2:   toNumber(setup.takeProfit2 ?? setup.target2),
      takeProfit3:   toNumber(setup.takeProfit3 ?? setup.target3),
      riskReward:    toNumber(setup.riskReward),
      invalidation:  setup.invalidation || setup.validity || 'Not visible',
      timeframeBias: setup.timeframeBias || setup.htfBias || 'Not visible',
    },
    probability: {
      bullish:    toNumber(prob.bullish,  null),
      bearish:    toNumber(prob.bearish,  null),
      sideways:   toNumber(prob.sideways, null),
      confidence: toNumber(prob.confidence ?? raw.confidence ?? raw.confidenceScore, 0),
    },
    confidence: Math.max(0, Math.min(100, toNumber(raw.confidence ?? raw.confidenceScore, 0))),
    volumeAnalysis:   raw.volumeAnalysis   || 'Not visible',
    volumeDivergence: raw.volumeDivergence || 'Not visible',
    openInterest:     raw.openInterest     || 'Not visible',
    fundingRate:      raw.fundingRate      || 'Not visible',
    warnings:         normalizeArray(raw.warnings || raw.warning),
    summary:          raw.summary || 'No summary generated.',
    keyObservations:  normalizeArray(raw.keyObservations || raw.observations),
    scenarioAnalysis: {
      bullCase: raw.scenarioAnalysis?.bullCase || raw.bullCase || 'Not provided',
      bearCase: raw.scenarioAnalysis?.bearCase || raw.bearCase || 'Not provided',
      baseCase: raw.scenarioAnalysis?.baseCase || raw.baseCase || 'Not provided',
    },
    indicators: raw.indicators || {},
    btcContext: raw.btcContext  || raw.marketContext || null,
    metadata: {
      pair:         metadata.pair         || raw.pair      || raw.coin || 'Not visible',
      timeframe:    metadata.timeframe    || raw.timeframe || 'Not visible',
      exchange:     metadata.exchange     || raw.exchange  || 'Not visible',
      currentPrice: metadata.currentPrice || raw.currentPrice || 'Not visible',
    },
    provider: 'Gemini',
  };
}

function classifyProviderError(message, statusCode = 502) {
  const text  = String(message || '');
  const lower = text.toLowerCase();
  if (lower.includes('quota') || lower.includes('billing') || lower.includes('rate-limit') || lower.includes('rate limit')) {
    return Object.assign(new Error(text), {
      statusCode: 503,
      publicMessage: 'Gemini quota or billing exhausted. The image uploaded correctly.',
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

function buildPrompt(extraData) {
  return `You are ChartMind AI — an elite institutional crypto trading analyst combining ICT/SMC methodology, technical analysis, volume profiling, and on-chain awareness.

ANALYSIS FRAMEWORK (apply all that are visible in the chart):

1. MARKET STRUCTURE (weight: 25%)
   - Identify: HH, HL, LH, LL sequences
   - Detect BOS (Break of Structure) and CHOCH (Change of Character)
   - Spot Order Blocks (OB), Fair Value Gaps (FVG), Breaker Blocks
   - Identify liquidity pools, equal highs/lows, stop hunt zones

2. MULTI-TIMEFRAME BIAS
   - Read the visible timeframe, infer HTF bias from chart structure
   - Note if price is at premium or discount relative to range midpoint
   - Identify alignment or conflict between visible TF and likely HTF

3. SUPPORT & RESISTANCE (weight: 10%)
   - Key structural levels, previous swing highs/lows
   - Psychological levels (round numbers)
   - Dynamic S/R from visible moving averages

4. VOLUME ANALYSIS (weight: 15%)
   - Buying vs selling volume dominance
   - Volume spikes on breakouts/rejections
   - Volume divergences (price up, volume down = weakness)
   - Relative volume vs recent average

5. MOVING AVERAGES
   - Read MA20, MA50, MA100, MA200 if visible
   - Note crossovers, slope direction, price distance from MAs
   - Bull/bear alignment (price above/below key MAs)

6. MOMENTUM INDICATORS
   - RSI: value, overbought/oversold, hidden/regular divergences
   - MACD: histogram direction, signal cross, momentum shifts
   - Stochastic RSI: if visible, note cross and zone

7. CANDLESTICK PATTERNS
   - Identify: engulfing, hammer, shooting star, doji, morning/evening star, three soldiers/crows, pin bars, inside bars
   - Note where pattern forms (key level = high significance)

8. FUTURES CONTEXT (from BTC data provided)
   - Open Interest trend relative to price
   - Funding rate sentiment
   - Liquidation cluster awareness

9. BTC CORRELATION (weight: 15%)
   - Use BTC regime data provided to assess market beta risk
   - If altcoin: does BTC trend support or contradict the setup?
   - If BTC: use as primary confirmation

STRICT RULES:
- ONLY analyze what is VISIBLE in the chart. Never invent data.
- If an indicator is not visible, return "Not visible" — do not guess.
- Probability scores must sum to 100.
- Be specific with price levels — use exact numbers from the chart.
- Summary must be 5-7 sentences minimum, institutional quality.
- Generate 3 take profit levels when a trade direction exists.

Return ONLY valid JSON with no markdown or extra text:
{
  "trend": "bullish | bearish | neutral",
  "marketStructure": "one-line SMC/ICT market structure read",
  "marketStructureDetail": {
    "pattern": "e.g. Bullish continuation after BOS at 103200",
    "bos": "BOS confirmed above 104100 | Not visible",
    "choch": "CHOCH formed at 102800 | Not visible",
    "higherHighs": true,
    "higherLows": true,
    "lowerHighs": false,
    "lowerLows": false,
    "orderBlocks": ["103200-103500 bullish OB"],
    "fairValueGaps": ["103800-104000 FVG unfilled"],
    "liquidityZones": ["104900 equal highs liquidity"]
  },
  "support": ["103200", "102400"],
  "resistance": ["104900", "106000"],
  "psychologicalLevels": ["100000", "105000"],
  "candlePattern": "Bullish engulfing at 4H support | Not visible",
  "rsi": 62,
  "macd": "Bullish crossover, histogram expanding",
  "stochRsi": "Crossing up from oversold | Not visible",
  "movingAverages": {
    "ma20": "103400 acting as dynamic support",
    "ma50": "101800 below price bullish",
    "ma100": "98200 far below strong uptrend",
    "ma200": "87000 far below macro bull",
    "alignment": "Bullish stack — price above all MAs",
    "crossovers": "MA20 crossed above MA50 recently"
  },
  "tradeSetup": {
    "direction": "BUY | SELL | NO TRADE",
    "entry": 103500,
    "stopLoss": 102200,
    "takeProfit1": 105200,
    "takeProfit2": 106800,
    "takeProfit3": 109000,
    "riskReward": 2.8,
    "invalidation": "4H close below 102200 OB invalidates bullish thesis",
    "timeframeBias": "HTF bullish, LTF pullback entry opportunity"
  },
  "probability": {
    "bullish": 65,
    "bearish": 20,
    "sideways": 15,
    "confidence": 78
  },
  "volumeAnalysis": "Volume expanding on green candles, contracting on red",
  "volumeDivergence": "Price making HH but volume declining — watch for fakeout",
  "openInterest": "Rising OI with price rise — trend confirmed | Not visible",
  "fundingRate": "Slightly positive 0.01% | Not visible",
  "scenarioAnalysis": {
    "bullCase": "Break above 104900 with volume targets 106800 then 109000",
    "bearCase": "Rejection at 104900 break below 103200 opens path to 101800",
    "baseCase": "Consolidation between 103200 and 104900 before resolution"
  },
  "warnings": ["Volume not confirming current move"],
  "summary": "5-7 sentence institutional quality analysis",
  "keyObservations": ["BOS confirmed at 103200", "RSI hidden bullish divergence on 4H"],
  "btcContext": "BTC bullish regime supports altcoin long setups",
  "metadata": {
    "pair": "BTC/USDT",
    "timeframe": "4H",
    "exchange": "Binance",
    "currentPrice": "103847"
  }
}

LIVE CONTEXT DATA:
OCR Text from chart: ${extraData.ocrText || 'None extracted'}
BTC Market Regime: ${JSON.stringify(extraData.marketContext || {}, null, 2)}
Image metadata: ${JSON.stringify(extraData.originalImage || {}, null, 2)}`;
}

async function requestGemini({ model, base64Image, extraData, signal }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.1,
          topP: 0.75,
          maxOutputTokens: 2800,
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
            { text: buildPrompt(extraData) },
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

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
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
  const request     = withTimeout(async (signal) => {
    let lastError;
    for (const model of GEMINI_MODELS) {
      try {
        return await requestGemini({ model, base64Image, extraData, signal });
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
