import fetch from 'node-fetch';

const COINGECKO_BASE_URL = process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3';
const PRICE_TIMEOUT_MS = Number(process.env.PRICE_TIMEOUT_MS || 12_000);

const COIN_ALIASES = new Map([
  ['btc', 'bitcoin'],
  ['xbt', 'bitcoin'],
  ['bitcoin', 'bitcoin'],
  ['eth', 'ethereum'],
  ['ethereum', 'ethereum'],
  ['sol', 'solana'],
  ['solana', 'solana'],
  ['bnb', 'binancecoin'],
  ['ada', 'cardano'],
  ['xrp', 'ripple'],
  ['doge', 'dogecoin'],
  ['dogecoin', 'dogecoin'],
  ['link', 'chainlink'],
  ['matic', 'matic-network'],
  ['pol', 'polygon-ecosystem-token'],
  ['avax', 'avalanche-2'],
  ['ton', 'the-open-network'],
  ['sui', 'sui'],
  ['pepe', 'pepe'],
  ['trx', 'tron'],
]);

function withTimeout(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
}

export function resolveCoinId(input = '') {
  const key = String(input).trim().toLowerCase().replace(/^\$/, '');
  return COIN_ALIASES.get(key) || key;
}

export function supportedCoinList() {
  return 'BTC, ETH, SOL, BNB, XRP, ADA, DOGE, LINK, AVAX, TON, SUI, PEPE, TRX';
}

export async function getCoinPriceSnapshot(input) {
  const coinId = resolveCoinId(input);
  if (!coinId) throw new Error('Coin symbol is required.');

  const req = withTimeout(PRICE_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({
      vs_currency: 'usd',
      ids: coinId,
      price_change_percentage: '1h,24h,7d',
    });
    const res = await fetch(`${COINGECKO_BASE_URL}/coins/markets?${params.toString()}`, {
      signal: req.signal,
      headers: { accept: 'application/json', 'User-Agent': 'ChartMindAI/2.0' },
    });
    if (!res.ok) throw new Error(`CoinGecko price failed: ${res.status}`);
    const data = await res.json();
    const coin = data?.[0];
    if (!coin) throw new Error(`No price data found for ${input}.`);

    return {
      id: coin.id,
      symbol: String(coin.symbol || coinId).toUpperCase(),
      name: coin.name || coinId,
      price: Number(coin.current_price),
      change1h: Number(coin.price_change_percentage_1h_in_currency),
      change24h: Number(coin.price_change_percentage_24h_in_currency),
      change7d: Number(coin.price_change_percentage_7d_in_currency),
      volume24h: Number(coin.total_volume),
      marketCapRank: coin.market_cap_rank,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    req.clear();
  }
}
