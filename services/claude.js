import fetch from 'node-fetch';

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 40_000);

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
      publicMessage: 'The AI provider returned unstructured output.',
      retryable: true,
    });
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('AI response JSON was malformed.'), {
      statusCode: 502,
      publicMessage: 'The AI provider returned malformed JSON.',
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
    provider: 'Claude',
  };
}

async function requestClaude({ base64Image, extraData, prompt, signal }) {
  const response = await fetch(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1800,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || `Claude request failed with status ${response.status}`;
    throw Object.assign(new Error(message), {
      statusCode: response.status >= 500 ? 502 : response.status,
      retryable: response.status >= 500,
    });
  }

  const text = data?.content?.[0]?.text || '';
  if (!text) {
    throw Object.assign(new Error('Claude returned an empty analysis.'), {
      statusCode: 502,
      retryable: true,
    });
  }

  return normalizeAnalysis(extractJson(text));
}

export async function analyzeChart(imagePath, extraData = {}) {
  if (!CLAUDE_API_KEY) {
    throw Object.assign(new Error('Claude API key is not configured.'), { statusCode: 500 });
  }

  const base64Image = await (await import('fs/promises')).readFile(imagePath, 'base64');

  const prompt = `You are a professional institutional trading analyst. Analyze this chart for trade opportunities.

Return ONLY valid JSON:
{
  "trend": "bullish | bearish | neutral",
  "marketStructure": "market structure read",
  "support": ["level1"],
  "resistance": ["level2"],
  "rsi": 65,
  "macd": "interpretation",
  "tradeSetup": {
    "direction": "BUY | SELL | NO TRADE",
    "entry": 103500,
    "stopLoss": 102200,
    "takeProfit": 106800,
    "riskReward": 2.5,
    "invalidation": "invalidation level"
  },
  "confidence": 85,
  "warnings": ["warning if any"],
  "summary": "Brief analysis",
  "keyObservations": ["observation"],
  "indicators": {"rsi": "reading", "macd": "reading"},
  "volumeAnalysis": "volume interpretation",
  "btcContext": "BTC context",
  "metadata": {"pair": "BTC/USDT", "timeframe": "4H", "exchange": "Binance", "currentPrice": "price"}
}

OCR: ${extraData.ocrText || 'None'}
BTC: ${JSON.stringify(extraData.marketContext || {})}`;

  const request = withTimeout(async (signal) => {
    try {
      return await requestClaude({ base64Image, extraData, prompt, signal });
    } catch (error) {
      console.error('[claude]', error.message);
      throw error;
    }
  }, CLAUDE_TIMEOUT_MS);

  try {
    return await request.run();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('Claude analysis timed out.'), { statusCode: 504 });
    }
    throw error;
  }
}
