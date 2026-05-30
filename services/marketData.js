import fetch from 'node-fetch';
import { EMA, RSI } from 'technicalindicators';

const BINANCE_BASE_URL = process.env.BINANCE_MARKET_BASE_URL || 'https://api.binance.com';
const BYBIT_BASE_URL   = process.env.BYBIT_MARKET_BASE_URL   || 'https://api.bybit.com';
const COINGECKO_BASE_URL = process.env.COINGECKO_BASE_URL    || 'https://api.coingecko.com/api/v3';

// Longer timeout — Render cold starts + cloud IP routing can be slow
const MARKET_TIMEOUT_MS = Number(process.env.MARKET_TIMEOUT_MS || 50_000);

function withTimeout(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
}

function pctChange(first, last) {
  if (!first || !last) return null;
  return Number((((last - first) / first) * 100).toFixed(2));
}

function classifyTrend({ close, ema20, ema50, change24h, rsi }) {
  if (!close || !ema20 || !ema50) return 'unknown';
  const bullish = close > ema20 && ema20 > ema50 && change24h > 0;
  const bearish = close < ema20 && ema20 < ema50 && change24h < 0;
  if (bullish && rsi >= 50) return 'bullish';
  if (bearish && rsi <= 50) return 'bearish';
  return 'mixed';
}

// ─── Binance ────────────────────────────────────────────────────────────────

async function fetchBinanceKlines(interval, limit) {
  const req = withTimeout(MARKET_TIMEOUT_MS);
  try {
    const url = `${BINANCE_BASE_URL}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: req.signal, headers: { 'User-Agent': 'ChartMindAI/2.0' } });
    if (!res.ok) throw new Error(`Binance ${interval} failed: ${res.status}`);
    return res.json();
  } finally {
    req.clear();
  }
}

function summarizeBinanceKlines(klines) {
  const closes  = klines.map(c => Number(c[4])).filter(Number.isFinite);
  const volumes = klines.map(c => Number(c[5])).filter(Number.isFinite);
  const last    = closes.at(-1);
  const ema20   = EMA.calculate({ values: closes, period: 20 }).at(-1);
  const ema50   = EMA.calculate({ values: closes, period: 50 }).at(-1);
  const rsi     = RSI.calculate({ values: closes, period: 14 }).at(-1);
  const recent  = volumes.slice(-6).reduce((s, v) => s + v, 0) / Math.max(volumes.slice(-6).length, 1);
  const base    = volumes.slice(-30, -6).reduce((s, v) => s + v, 0) / Math.max(volumes.slice(-30, -6).length, 1);
  return {
    price: Number(last?.toFixed(2)),
    ema20: Number(ema20?.toFixed(2)),
    ema50: Number(ema50?.toFixed(2)),
    rsi:   Number(rsi?.toFixed(2)),
    change: pctChange(closes[0], last),
    volumeState: base && recent > base * 1.15 ? 'expanding' : base && recent < base * 0.85 ? 'contracting' : 'normal',
  };
}

async function getBinanceContext() {
  const [fourHour, daily] = await Promise.all([
    fetchBinanceKlines('4h', 80),
    fetchBinanceKlines('1d', 90),
  ]);
  const intraday       = summarizeBinanceKlines(fourHour);
  const higherTimeframe = summarizeBinanceKlines(daily);
  const trend = classifyTrend({
    close: intraday.price, ema20: intraday.ema20, ema50: intraday.ema50,
    change24h: higherTimeframe.change, rsi: intraday.rsi,
  });
  return { source: 'Binance BTCUSDT', fetchedAt: new Date().toISOString(), trend, intraday, higherTimeframe,
    note: 'Use BTC as broad crypto market regime context. Do not override the uploaded chart setup with BTC data.' };
}

// ─── Bybit (fallback 1) ──────────────────────────────────────────────────────
// Bybit is more permissive with cloud hosting IPs than Binance

async function fetchBybitKlines(interval, limit) {
  const req = withTimeout(MARKET_TIMEOUT_MS);
  try {
    // Bybit V5: interval in minutes (240 = 4h, D = 1day)
    const url = `${BYBIT_BASE_URL}/v5/market/kline?category=linear&symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: req.signal, headers: { 'User-Agent': 'ChartMindAI/2.0' } });
    if (!res.ok) throw new Error(`Bybit klines failed: ${res.status}`);
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);
    // Bybit returns [startTime, open, high, low, close, volume, turnover] newest-first → reverse
    return data.result.list.reverse();
  } finally {
    req.clear();
  }
}

function summarizeBybitKlines(klines) {
  // Bybit kline array: [startTime, open, high, low, close, volume, turnover]
  const closes  = klines.map(c => Number(c[4])).filter(Number.isFinite);
  const volumes = klines.map(c => Number(c[5])).filter(Number.isFinite);
  const last    = closes.at(-1);
  const ema20   = EMA.calculate({ values: closes, period: 20 }).at(-1);
  const ema50   = EMA.calculate({ values: closes, period: 50 }).at(-1);
  const rsi     = RSI.calculate({ values: closes, period: 14 }).at(-1);
  const recent  = volumes.slice(-6).reduce((s, v) => s + v, 0) / Math.max(volumes.slice(-6).length, 1);
  const base    = volumes.slice(-30, -6).reduce((s, v) => s + v, 0) / Math.max(volumes.slice(-30, -6).length, 1);
  return {
    price:  Number(last?.toFixed(2)),
    ema20:  Number(ema20?.toFixed(2)),
    ema50:  Number(ema50?.toFixed(2)),
    rsi:    Number(rsi?.toFixed(2)),
    change: pctChange(closes[0], last),
    volumeState: base && recent > base * 1.15 ? 'expanding' : base && recent < base * 0.85 ? 'contracting' : 'normal',
  };
}

async function getBybitContext() {
  const [fourHour, daily] = await Promise.all([
    fetchBybitKlines('240', 80),   // 240 min = 4h
    fetchBybitKlines('D', 90),
  ]);
  const intraday        = summarizeBybitKlines(fourHour);
  const higherTimeframe = summarizeBybitKlines(daily);
  const trend = classifyTrend({
    close: intraday.price, ema20: intraday.ema20, ema50: intraday.ema50,
    change24h: higherTimeframe.change, rsi: intraday.rsi,
  });
  return { source: 'Bybit BTCUSDT', fetchedAt: new Date().toISOString(), trend, intraday, higherTimeframe,
    note: 'Use BTC as broad crypto market regime context. Do not override the uploaded chart setup with BTC data.' };
}

// ─── CoinGecko (fallback 2) ──────────────────────────────────────────────────

async function fetchJson(url) {
  const req = withTimeout(MARKET_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: req.signal, headers: { accept: 'application/json', 'User-Agent': 'ChartMindAI/2.0' } });
    if (!res.ok) throw new Error(`Request failed: ${res.status} ${url}`);
    return res.json();
  } finally {
    req.clear();
  }
}

function summarizePrices(prices) {
  const closes = prices.map(p => Number(p[1])).filter(Number.isFinite);
  const last   = closes.at(-1);
  return {
    price:  Number(last?.toFixed(2)),
    ema20:  Number(EMA.calculate({ values: closes, period: 20 }).at(-1)?.toFixed(2)),
    ema50:  Number(EMA.calculate({ values: closes, period: 50 }).at(-1)?.toFixed(2)),
    rsi:    Number(RSI.calculate({ values: closes, period: 14 }).at(-1)?.toFixed(2)),
    change: pctChange(closes[0], last),
    volumeState: 'not provided',
  };
}

async function getCoinGeckoContext() {
  const [chart, market] = await Promise.all([
    fetchJson(`${COINGECKO_BASE_URL}/coins/bitcoin/market_chart?vs_currency=usd&days=90`),
    fetchJson(`${COINGECKO_BASE_URL}/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h,7d`),
  ]);
  const higherTimeframe = summarizePrices(chart.prices || []);
  const intraday = {
    ...higherTimeframe,
    change: Number(market?.[0]?.price_change_percentage_24h?.toFixed?.(2) ?? higherTimeframe.change),
    price:  Number(market?.[0]?.current_price?.toFixed?.(2) ?? higherTimeframe.price),
    volumeState: market?.[0]?.total_volume
      ? `24h volume ${Number(market[0].total_volume).toLocaleString('en-US')}`
      : 'not provided',
  };
  const trend = classifyTrend({ close: intraday.price, ema20: higherTimeframe.ema20, ema50: higherTimeframe.ema50, change24h: intraday.change, rsi: higherTimeframe.rsi });
  return { source: 'CoinGecko bitcoin', fetchedAt: new Date().toISOString(), trend, intraday, higherTimeframe,
    note: 'Use BTC as broad crypto market regime context. Do not override the uploaded chart setup with BTC data.' };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function getBitcoinMarketContext() {
  // Try Binance first
  try {
    const ctx = await getBinanceContext();
    console.log('[marketData] Binance OK — BTC:', ctx.intraday.price);
    return ctx;
  } catch (e) {
    console.error('[marketData] Binance failed:', e.message);
  }

  // Try Bybit second (more permissive with cloud IPs)
  try {
    const ctx = await getBybitContext();
    console.log('[marketData] Bybit OK — BTC:', ctx.intraday.price);
    return ctx;
  } catch (e) {
    console.error('[marketData] Bybit failed:', e.message);
  }

  // Try CoinGecko last
  try {
    const ctx = await getCoinGeckoContext();
    console.log('[marketData] CoinGecko OK — BTC:', ctx.intraday.price);
    return ctx;
  } catch (e) {
    console.error('[marketData] CoinGecko failed:', e.message);
  }

  // All failed
  console.error('[marketData] All providers failed');
  return {
    source: 'unavailable',
    fetchedAt: new Date().toISOString(),
    trend: 'unknown',
    error: 'BTC market context unavailable during this analysis.',
  };
}


// ─── In-memory BTC cache ─────────────────────────────────────────────────────
// Caches the last successful BTC context for up to 90 seconds.
// This means repeat requests (web UI retries, bot users) get instant
// market data instead of waiting for a full provider round-trip.

const CACHE_TTL_MS = Number(process.env.BTC_CACHE_TTL_MS || 90_000); // 90 s

export const btcCache = (() => {
  let _data      = null;
  let _fetchedAt = 0;
  let _inflight  = null; // deduplicate concurrent fetches

  return {
    /** True if a valid, non-expired result is sitting in cache. */
    fresh() {
      return _data !== null && Date.now() - _fetchedAt < CACHE_TTL_MS;
    },

    /** Returns cached data or null. */
    get() {
      return this.fresh() ? _data : null;
    },

    set(data) {
      _data      = data;
      _fetchedAt = Date.now();
    },

    /** Deduplication: if a fetch is already in-flight, return the same promise. */
    getInflight() { return _inflight; },
    setInflight(p) {
      _inflight = p;
      p.finally(() => { _inflight = null; });
    },
  };
})();

// Wrap getBitcoinMarketContext with caching + deduplication.
const _rawGetBitcoinMarketContext = getBitcoinMarketContext;

// Re-export with cache layer
export async function getBitcoinMarketContext() {
  // Cache hit — return instantly
  const cached = btcCache.get();
  if (cached) {
    console.log('[marketData] Cache hit — BTC:', cached.intraday?.price);
    return cached;
  }

  // Deduplicate: if a fetch is already running, wait for it
  const existing = btcCache.getInflight();
  if (existing) {
    console.log('[marketData] Joining in-flight BTC fetch');
    return existing;
  }

  // Start a new fetch
  const promise = _rawGetBitcoinMarketContext().then((ctx) => {
    btcCache.set(ctx);
    return ctx;
  });

  btcCache.setInflight(promise);
  return promise;
}
