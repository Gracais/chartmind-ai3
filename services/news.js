import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const NEWS_TIMEOUT_MS = Number(process.env.NEWS_TIMEOUT_MS || 8_000);

/**
 * RSS fallback — scrapes CoinTelegraph & Decrypt when no NewsAPI key
 */
async function fetchRssFallback(coin, limit) {
  const feeds = [
    'https://cointelegraph.com/rss',
    'https://decrypt.co/feed',
  ];
  const news = [];
  const parser = new XMLParser();
  const keyword = coin.toLowerCase();

  for (const url of feeds) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), NEWS_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const xml = await res.text();
      const parsed = parser.parse(xml);
      const items = parsed?.rss?.channel?.item || [];
      const filtered = items
        .filter(item => {
          const text = `${item.title} ${item.description || ''}`.toLowerCase();
          return text.includes(keyword) || text.includes('bitcoin') || text.includes('crypto');
        })
        .slice(0, limit)
        .map(item => ({
          title: item.title,
          description: item.description || '',
          url: item.link,
          source: new URL(url).hostname.replace('www.', ''),
          publishedAt: new Date(item.pubDate || Date.now()),
          sentiment: analyzeSentiment(item.title + ' ' + (item.description || '')),
        }));
      news.push(...filtered);
    } catch (err) {
      console.error('[news] RSS error:', url, err.message);
    }
    if (news.length >= limit) break;
  }
  return news.slice(0, limit);
}

/**
 * Fetch recent crypto news — NewsAPI first, RSS fallback
 */
export async function fetchCryptoNews(coin = 'bitcoin', limit = 5) {
  const news = [];

  if (NEWS_API_KEY) {
    const query = `${coin} crypto news`;
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=en&pageSize=${limit}&apiKey=${NEWS_API_KEY}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NEWS_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();
      clearTimeout(timeout);
      if (data.articles) {
        news.push(...data.articles.slice(0, limit).map(article => ({
          title: article.title,
          description: article.description,
          url: article.url,
          source: article.source.name,
          publishedAt: new Date(article.publishedAt),
          sentiment: analyzeSentiment(article.title + ' ' + (article.description || '')),
        })));
      }
    } catch (err) {
      console.error('[news] NewsAPI error:', err.message);
    }
  }

  // Fill remaining slots with RSS if NewsAPI didn't cover it
  if (news.length < limit) {
    const rssNews = await fetchRssFallback(coin, limit - news.length);
    news.push(...rssNews);
  }

  return news;
}

/**
 * Simple sentiment analysis — returns bullish, bearish, or neutral
 */
function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  const bullishKeywords = ['surge', 'soar', 'bull', 'rally', 'recovery', 'pump', 'growth', 'gains', 'approval', 'launch', 'partnership', 'uptick', 'positive', 'strong'];
  const bearishKeywords = ['crash', 'plunge', 'bear', 'dump', 'decline', 'fall', 'loss', 'drop', 'hack', 'scandal', 'rejection', 'downside', 'negative', 'weak', 'ban', 'risk'];
  let bullishScore = 0;
  let bearishScore = 0;
  bullishKeywords.forEach(kw => { if (lower.includes(kw)) bullishScore++; });
  bearishKeywords.forEach(kw => { if (lower.includes(kw)) bearishScore++; });
  if (bullishScore > bearishScore) return 'bullish';
  if (bearishScore > bullishScore) return 'bearish';
  return 'neutral';
}

/**
 * Format news items for Telegram display
 */
export function formatNewsDigest(newsItems, coinLabel = '') {
  if (!newsItems?.length) return `📰 No recent news found${coinLabel ? ` for ${coinLabel}` : ''}.`;
  const sentimentIcon = { bullish: '🟢', bearish: '🔴', neutral: '⚪' };
  const lines = [
    `*📰 Crypto News${coinLabel ? ` — ${coinLabel}` : ''}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ];
  newsItems.forEach((item, i) => {
    const icon = sentimentIcon[item.sentiment] || '⚪';
    const age = Math.round((Date.now() - item.publishedAt) / 3_600_000);
    const ageLabel = age < 1 ? 'just now' : `${age}h ago`;
    lines.push(`${icon} *${item.title}*`);
    lines.push(`  _${item.source} · ${ageLabel}_`);
    if (i < newsItems.length - 1) lines.push('');
  });
  return lines.join('\n');
}

/**
 * Merge news sentiment into an existing chart analysis object
 */
export function integrateNewsIntoAnalysis(analysis, newsItems = []) {
  if (!newsItems || newsItems.length === 0) return analysis;

  const bullishNews = newsItems.filter(n => n.sentiment === 'bullish');
  const bearishNews = newsItems.filter(n => n.sentiment === 'bearish');
  let newsInfluence = '';
  let confidenceAdjustment = 0;

  if (bullishNews.length > bearishNews.length) {
    newsInfluence = `Recent news sentiment is bullish (${bullishNews.length} positive vs ${bearishNews.length} negative stories).`;
    confidenceAdjustment = 5;
  } else if (bearishNews.length > bullishNews.length) {
    newsInfluence = `Recent news sentiment is bearish (${bearishNews.length} negative vs ${bullishNews.length} positive stories).`;
    confidenceAdjustment = -5;
  } else if (newsItems.length > 0) {
    newsInfluence = `Mixed news sentiment detected.`;
  }

  if (newsInfluence) {
    analysis.warnings = analysis.warnings || [];
    analysis.warnings.push(`News Context: ${newsInfluence}`);
    analysis.summary = (analysis.summary || '') + `\n\n📰 ${newsInfluence}`;
  }

  analysis.confidence = Math.max(0, Math.min(100, (analysis.confidence || 50) + confidenceAdjustment));
  analysis.recentNews = newsItems.slice(0, 3);

  return analysis;
}

/**
 * Fetch news and merge into analysis — used inside handlePhoto
 */
export async function analyzeWithNews(analysis, coin = 'bitcoin') {
  try {
    const news = await fetchCryptoNews(coin, 5);
    return integrateNewsIntoAnalysis(analysis, news);
  } catch (err) {
    console.error('[news integration] error:', err.message);
    return analysis;
  }
}
