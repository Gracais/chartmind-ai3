import fetch from 'node-fetch';

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const NEWS_TIMEOUT_MS = Number(process.env.NEWS_TIMEOUT_MS || 8_000);

/**
 * Fetch recent crypto news that might affect price trends
 * Uses CoinTelegraph RSS + NewsAPI for comprehensive coverage
 */
async function fetchCryptoNews(coin = 'bitcoin', limit = 5) {
  const news = [];
  
  try {
    // Try NewsAPI first (requires key, but comprehensive)
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
  } catch (err) {
    console.error('[news] fetch error:', err.message);
  }

  return news;
}

/**
 * Simple sentiment analysis of news title/description
 * Returns: bullish, bearish, or neutral
 */
function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  
  const bullishKeywords = ['surge', 'soar', 'bull', 'rally', 'recovery', 'pump', 'growth', 'gains', 'approval', 'launch', 'partnership', 'uptick', 'positive', 'strong'];
  const bearishKeywords = ['crash', 'plunge', 'bear', 'dump', 'decline', 'fall', 'loss', 'drop', 'hack', 'scandal', 'rejection', 'downside', 'negative', 'weak', 'ban', 'risk'];
  
  let bullishScore = 0;
  let bearishScore = 0;
  
  bullishKeywords.forEach(kw => {
    if (lower.includes(kw)) bullishScore++;
  });
  
  bearishKeywords.forEach(kw => {
    if (lower.includes(kw)) bearishScore++;
  });
  
  if (bullishScore > bearishScore) return 'bullish';
  if (bearishScore > bullishScore) return 'bearish';
  return 'neutral';
}

/**
 * Analyze how recent news affects chart analysis
 */
export function integrateNewsIntoAnalysis(analysis, newsItems = []) {
  if (!newsItems || newsItems.length === 0) {
    return analysis;
  }

  const bullishNews = newsItems.filter(n => n.sentiment === 'bullish');
  const bearishNews = newsItems.filter(n => n.sentiment === 'bearish');
  
  let newsInfluence = '';
  let confidenceAdjustment = 0;

  if (bullishNews.length > bearishNews.length) {
    newsInfluence = `Recent news sentiment is bullish (${bullishNews.length} positive vs ${bearishNews.length} negative stories).`;
    confidenceAdjustment = 5; // Slight boost to confidence
  } else if (bearishNews.length > bullishNews.length) {
    newsInfluence = `Recent news sentiment is bearish (${bearishNews.length} negative vs ${bullishNews.length} positive stories).`;
    confidenceAdjustment = -5; // Slight reduction
  } else if (newsItems.length > 0) {
    newsInfluence = `Mixed news sentiment detected.`;
  }

  // Add news context to warnings
  if (newsInfluence) {
    analysis.warnings = analysis.warnings || [];
    analysis.warnings.push(`News Context: ${newsInfluence}`);
  }

  // Adjust confidence based on news
  analysis.confidence = Math.max(0, Math.min(100, (analysis.confidence || 50) + confidenceAdjustment));

  // Add news to summary
  if (newsInfluence) {
    analysis.summary = (analysis.summary || '') + `\n\n📰 ${newsInfluence}`;
  }

  // Store raw news for display
  analysis.recentNews = newsItems.slice(0, 3);

  return analysis;
}

export async function analyzeWithNews(analysis, coin = 'bitcoin') {
  try {
    const news = await fetchCryptoNews(coin, 5);
    return integrateNewsIntoAnalysis(analysis, news);
  } catch (err) {
    console.error('[news integration] error:', err.message);
    return analysis; // Return original if news fetch fails
  }
}
