import 'dotenv/config';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import fetch from 'node-fetch';

import { analyzeChart as analyzeChartGPT }    from './services/chatgpt.js';
import { analyzeChart as analyzeChartGemini } from './services/gemini.js';
import { analyzeChartWithOpenRouter }          from './services/openrouter.js';
import { getBitcoinMarketContext }             from './services/marketData.js';
import { extractChartText }                   from './services/ocr.js';
import { preprocessChartImage }               from './services/preprocess.js';
import { addCodexAnalyst }                    from './services/codexAnalyst.js';
import { getCoinPriceSnapshot, resolveCoinId, supportedCoinList } from './services/coinPrices.js';
import { analyzeWithNews, fetchCryptoNews, formatNewsDigest }     from './services/news.js';

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const API      = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;
const ALERT_CHECK_MS        = Number(process.env.ALERT_CHECK_MS        || 60_000);
const DEFAULT_SPIKE_PERCENT = Number(process.env.DEFAULT_SPIKE_PERCENT || 3);
const DATA_DIR              = process.env.DATA_DIR || './data';
const HISTORY_LIMIT         = 5;
const BRIEF_CHECK_MS        = 60_000;

// ─── Persistent storage ───────────────────────────────────────────────────────

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}

async function loadJson(file, fallback = {}) {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, file), 'utf8');
    return JSON.parse(raw);
  } catch { return fallback; }
}

async function saveJson(file, data) {
  await ensureDataDir();
  await fs.writeFile(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// In-memory state (loaded from disk on boot)
let alertsByChat    = new Map();
let watchlistByChat = new Map();
let historyByChat   = new Map();
let journalByChat   = new Map();
let briefsByChat    = new Map();
let feedbackLog     = [];
const pendingByChat = new Map();
let alertTimer      = null;
let briefTimer      = null;

async function persistAlerts() {
  const obj = {};
  for (const [k, v] of alertsByChat) obj[k] = v;
  await saveJson('alerts.json', obj);
}

async function persistWatchlist() {
  const obj = {};
  for (const [k, v] of watchlistByChat) obj[k] = v;
  await saveJson('watchlist.json', obj);
}

async function persistHistory() {
  const obj = {};
  for (const [k, v] of historyByChat) obj[k] = v;
  await saveJson('history.json', obj);
}

async function persistJournal() {
  const obj = {};
  for (const [k, v] of journalByChat) obj[k] = v;
  await saveJson('journal.json', obj);
}

async function persistBriefs() {
  const obj = {};
  for (const [k, v] of briefsByChat) obj[k] = v;
  await saveJson('briefs.json', obj);
}

async function loadAll() {
  await ensureDataDir();
  const alerts    = await loadJson('alerts.json', {});
  const watchlist = await loadJson('watchlist.json', {});
  const history   = await loadJson('history.json', {});
  const journal   = await loadJson('journal.json', {});
  const briefs    = await loadJson('briefs.json', {});
  feedbackLog     = await loadJson('feedback.json', []);

  for (const [k, v] of Object.entries(alerts))    alertsByChat.set(Number(k), v);
  for (const [k, v] of Object.entries(watchlist)) watchlistByChat.set(Number(k), v);
  for (const [k, v] of Object.entries(history))   historyByChat.set(Number(k), v);
  for (const [k, v] of Object.entries(journal))   journalByChat.set(Number(k), v);
  for (const [k, v] of Object.entries(briefs))    briefsByChat.set(Number(k), v);
  console.log('[nexus] Persistent data loaded.');
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function tgPost(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🟠 BTC Regime',  callback_data: 'btc' },
        { text: '💰 Price BTC',   callback_data: 'price:btc' },
        { text: '💰 Price ETH',   callback_data: 'price:eth' },
      ],
      [
        { text: '📰 News BTC',    callback_data: 'news:bitcoin' },
        { text: '📰 News ETH',    callback_data: 'news:ethereum' },
        { text: '📋 Watchlist',   callback_data: 'watchlist' },
      ],
      [
        { text: '📜 History',     callback_data: 'history' },
        { text: '📓 Journal',     callback_data: 'journal' },
        { text: '📊 Summary',     callback_data: 'summary' },
      ],
      [
        { text: '🔔 Set Alert',   callback_data: 'alert_menu' },
        { text: '🔔 My Alerts',   callback_data: 'alerts' },
        { text: '❓ Help',        callback_data: 'help' },
      ],
    ],
  };
}

function analysisKeyboard(pair = '') {
  const coinSlug = pair.split('/')[0].toLowerCase() || 'bitcoin';
  const coinId   = resolveCoinId(coinSlug) || coinSlug;
  return {
    inline_keyboard: [
      [
        { text: `🔔 Alert ${pair || 'this coin'}`, callback_data: `quickalert:${coinId}:3` },
        { text: `📰 News`,                          callback_data: `news:${coinId}` },
        { text: `💰 Price`,                         callback_data: `price:${coinId}` },
      ],
      [
        { text: '👍 Helpful',  callback_data: `feedback:good` },
        { text: '👎 Not helpful', callback_data: `feedback:bad` },
        { text: '📜 History',  callback_data: 'history' },
      ],
      [{ text: '« Main Menu', callback_data: 'menu' }],
    ],
  };
}

async function answerCallback(id, text = '') {
  if (!id) return;
  await tgPost('answerCallbackQuery', { callback_query_id: id, text, show_alert: false });
}

async function sendMessage(chatId, text, extra = {}) {
  return tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

async function editMessage(chatId, messageId, text) {
  return tgPost('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' });
}

async function downloadFile(fileId) {
  const info    = await fetch(`${API}/getFile?file_id=${fileId}`).then(r => r.json());
  if (!info.ok) throw new Error('Could not get file info from Telegram');
  const filePath = info.result.file_path;
  const ext      = path.extname(filePath) || '.jpg';
  const tmpPath  = path.join(os.tmpdir(), `nx_${Date.now()}${ext}`);
  const fileRes  = await fetch(`${FILE_API}/${filePath}`);
  const buffer   = await fileRes.arrayBuffer();
  await fs.writeFile(tmpPath, Buffer.from(buffer));
  return tmpPath;
}

// ─── AI provider chain ────────────────────────────────────────────────────────

async function analyzeWithFallbacks(imagePath, payload, statusId, chatId) {
  const errors = [];

  if (process.env.OPENAI_API_KEY) {
    try {
      await editMessage(chatId, statusId, '🤖 Analyzing with GPT-4o...');
      const result = await analyzeChartGPT(imagePath, payload);
      result.provider = 'ChatGPT (GPT-4o)';
      return result;
    } catch (err) {
      console.error('[nexus] ChatGPT failed:', err.statusCode, err.message);
      errors.push(`GPT: ${err.message}`);
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      await editMessage(chatId, statusId, '⚡ GPT busy — switching to Gemini...');
      const result = await analyzeChartGemini(imagePath, payload);
      result.provider = 'Gemini';
      return result;
    } catch (err) {
      console.error('[nexus] Gemini failed:', err.statusCode, err.message);
      errors.push(`Gemini: ${err.message}`);
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      await editMessage(chatId, statusId, '⚡ Switching to OpenRouter...');
      const result = await analyzeChartWithOpenRouter(imagePath, payload);
      result.provider = result.provider || 'OpenRouter';
      return result;
    } catch (err) {
      console.error('[nexus] OpenRouter failed:', err.statusCode, err.message);
      errors.push(`OpenRouter: ${err.message}`);
    }
  }

  console.error('[nexus] All providers failed:', errors.join(' | '));
  throw Object.assign(new Error('All AI providers failed.'), {
    statusCode: 503,
    publicMessage: 'All AI providers are currently unavailable. Please retry in a moment.',
  });
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function trendEmoji(trend) {
  if (!trend) return '⚪';
  const t = trend.toLowerCase();
  if (t.includes('bull') || t.includes('up'))   return '🟢';
  if (t.includes('bear') || t.includes('down')) return '🔴';
  return '🟡';
}

function directionEmoji(direction) {
  if (!direction) return '⚪';
  const d = direction.toUpperCase();
  if (d.includes('BUY')  || d.includes('LONG'))  return '📈';
  if (d.includes('SELL') || d.includes('SHORT')) return '📉';
  return '⏸';
}

function probBar(value) {
  if (value == null) return '';
  const filled = Math.round((value / 100) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${value}%`;
}

function formatAnalysis(analysis, marketContext) {
  const m    = analysis.metadata             || {};
  const s    = analysis.tradeSetup           || {};
  const ms   = analysis.marketStructureDetail || {};
  const prob = analysis.probability          || {};
  const sc   = analysis.scenarioAnalysis     || {};
  const ma   = analysis.movingAverages       || {};
  const btc  = marketContext?.intraday;
  const te   = trendEmoji(analysis.trend);
  const de   = directionEmoji(s.direction);
  const lines = [];

  lines.push(`*⚡ NEXUS — Institutional Analysis*`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`*Pair:* ${m.pair || 'Unknown'}  |  *TF:* ${m.timeframe || 'Unknown'}`);
  lines.push(`*Price:* ${m.currentPrice || 'Unknown'}  |  *Exchange:* ${m.exchange || 'Unknown'}`);
  lines.push('');

  lines.push(`*Market Trend:* ${te} ${(analysis.trend || 'neutral').toUpperCase()}`);
  if (analysis.marketStructure) lines.push(`*Structure:* ${analysis.marketStructure}`);
  if (ms.bos   && ms.bos   !== 'Not visible') lines.push(`*BOS:* ${ms.bos}`);
  if (ms.choch && ms.choch !== 'Not visible') lines.push(`*CHOCH:* ${ms.choch}`);
  if (ms.orderBlocks?.length)    lines.push(`*Order Blocks:* ${ms.orderBlocks.join(' | ')}`);
  if (ms.fairValueGaps?.length)  lines.push(`*FVGs:* ${ms.fairValueGaps.join(' | ')}`);
  if (ms.liquidityZones?.length) lines.push(`*Liquidity:* ${ms.liquidityZones.join(' | ')}`);
  lines.push('');

  if (prob.bullish != null) {
    lines.push(`*Probability Scenarios*`);
    lines.push(`  🟢 Bull: ${probBar(prob.bullish)}`);
    lines.push(`  🔴 Bear: ${probBar(prob.bearish)}`);
    lines.push(`  🟡 Side: ${probBar(prob.sideways)}`);
    lines.push(`*Confidence:* ${prob.confidence || analysis.confidence}/100`);
    lines.push('');
  }

  lines.push(`*${de} Setup: ${s.direction || 'NO TRADE'}*`);
  if (s.entry)        lines.push(`  Entry:    \`${s.entry}\``);
  if (s.stopLoss)     lines.push(`  Stop:     \`${s.stopLoss}\``);
  if (s.takeProfit1)  lines.push(`  TP1:      \`${s.takeProfit1}\``);
  if (s.takeProfit2)  lines.push(`  TP2:      \`${s.takeProfit2}\``);
  if (s.takeProfit3)  lines.push(`  TP3:      \`${s.takeProfit3}\``);
  if (s.riskReward)   lines.push(`  R:R:      ${s.riskReward}:1`);
  if (s.timeframeBias && s.timeframeBias !== 'Not visible') lines.push(`  HTF Bias: ${s.timeframeBias}`);
  if (s.invalidation  && s.invalidation  !== 'Not visible') lines.push(`  ❌ Invalidation: ${s.invalidation}`);
  lines.push('');

  if (analysis.support?.length)             lines.push(`*Support:* ${analysis.support.join(' | ')}`);
  if (analysis.resistance?.length)          lines.push(`*Resistance:* ${analysis.resistance.join(' | ')}`);
  if (analysis.psychologicalLevels?.length) lines.push(`*Psych Levels:* ${analysis.psychologicalLevels.join(' | ')}`);
  if (analysis.support?.length || analysis.resistance?.length) lines.push('');

  if (analysis.rsi)                                                        lines.push(`*RSI:* ${analysis.rsi}`);
  if (analysis.macd && analysis.macd !== 'Not visible')                    lines.push(`*MACD:* ${analysis.macd}`);
  if (analysis.stochRsi && analysis.stochRsi !== 'Not visible')            lines.push(`*Stoch RSI:* ${analysis.stochRsi}`);
  if (analysis.candlePattern && analysis.candlePattern !== 'Not visible')  lines.push(`*Pattern:* ${analysis.candlePattern}`);
  if (ma.alignment  && ma.alignment  !== 'Not visible')                    lines.push(`*MA Align:* ${ma.alignment}`);
  if (ma.crossovers && ma.crossovers !== 'Not visible')                    lines.push(`*MA Cross:* ${ma.crossovers}`);
  if (analysis.volumeAnalysis   && analysis.volumeAnalysis   !== 'Not visible') lines.push(`*Volume:* ${analysis.volumeAnalysis}`);
  if (analysis.volumeDivergence && analysis.volumeDivergence !== 'Not visible') lines.push(`*Vol Div:* ${analysis.volumeDivergence}`);
  if (analysis.openInterest     && analysis.openInterest     !== 'Not visible') lines.push(`*OI:* ${analysis.openInterest}`);
  if (analysis.fundingRate      && analysis.fundingRate      !== 'Not visible') lines.push(`*Funding:* ${analysis.fundingRate}`);
  lines.push('');

  if (btc && marketContext?.trend !== 'unknown') {
    lines.push(`*BTC Regime:* ${trendEmoji(marketContext.trend)} ${marketContext.trend?.toUpperCase()}`);
    lines.push(`  $${btc.price?.toLocaleString() || 'N/A'}  |  RSI: ${btc.rsi || 'N/A'}`);
    lines.push('');
  }

  lines.push(`*📝 Analysis*`);
  lines.push(analysis.summary || 'No summary.');
  lines.push('');

  if (sc.bullCase && sc.bullCase !== 'Not provided') {
    lines.push(`*📈 Bull Case:* ${sc.bullCase}`);
    lines.push(`*📉 Bear Case:* ${sc.bearCase}`);
    lines.push(`*⏸ Base Case:* ${sc.baseCase}`);
    lines.push('');
  }

  if (analysis.warnings?.length) {
    lines.push(`⚠️ ${analysis.warnings.join('\n⚠️ ')}`);
    lines.push('');
  }

  if (analysis.codexAnalyst) {
    const cx = analysis.codexAnalyst;
    lines.push(`*🔍 Codex Risk Score: ${cx.score}/100*`);
    lines.push(`  ${cx.verdict}`);
    if (cx.confluence?.length) lines.push(`  ${cx.confluence.slice(0, 3).join('\n  ')}`);
    if (cx.cautions?.length)   lines.push(`  ⚠️ ${cx.cautions[0]}`);
    lines.push('');
  }

  if (analysis.provider) lines.push(`_⚡ Analyzed by ${analysis.provider}_`);
  if (analysis.degraded)  lines.push(`_⚠️ Fallback mode — retry for full analysis._`);

  return lines.join('\n');
}

function formatBtcSnapshot(ctx, fearGreed = null) {
  if (!ctx || ctx.trend === 'unknown') {
    return '❌ *BTC market data unavailable right now.* Try again in a moment.';
  }
  const i  = ctx.intraday;
  const h  = ctx.higherTimeframe;
  const te = trendEmoji(ctx.trend);
  const lines = [
    `*🟠 BTC Regime — NEXUS*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*Trend:* ${te} ${ctx.trend?.toUpperCase()}`,
    `*Source:* ${ctx.source}`,
    '',
    `*4H Data*`,
    `  Price:  $${i?.price?.toLocaleString() || 'N/A'}`,
    `  RSI:    ${i?.rsi || 'N/A'}`,
    `  EMA20:  ${i?.ema20 || 'N/A'}`,
    `  EMA50:  ${i?.ema50 || 'N/A'}`,
    `  Volume: ${i?.volumeState || 'N/A'}`,
    '',
    `*Daily Data*`,
    `  24h Change: ${h?.change != null ? h.change + '%' : 'N/A'}`,
    `  EMA20:  ${h?.ema20 || 'N/A'}`,
    `  EMA50:  ${h?.ema50 || 'N/A'}`,
  ];

  if (fearGreed) {
    lines.push('');
    lines.push(`*Market Sentiment*`);
    lines.push(`  Fear & Greed: *${fearGreed.value}* — ${fearGreed.label}`);
  }

  lines.push('');
  lines.push(`_Fetched: ${new Date(ctx.fetchedAt).toUTCString()}_`);
  return lines.join('\n');
}

function formatPriceSnapshot(snapshot) {
  const price  = Number.isFinite(snapshot.price)    ? `$${snapshot.price.toLocaleString('en-US')}` : 'N/A';
  const c1h    = Number.isFinite(snapshot.change1h)  ? `${snapshot.change1h.toFixed(2)}%`  : 'N/A';
  const c24h   = Number.isFinite(snapshot.change24h) ? `${snapshot.change24h.toFixed(2)}%` : 'N/A';
  const c7d    = Number.isFinite(snapshot.change7d)  ? `${snapshot.change7d.toFixed(2)}%`  : 'N/A';
  const volume = Number.isFinite(snapshot.volume24h) ? `$${snapshot.volume24h.toLocaleString('en-US')}` : 'N/A';
  return [
    `*${snapshot.symbol} Price — NEXUS*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*Name:* ${snapshot.name}`,
    `*Price:* ${price}`,
    `*1H:* ${c1h}  |  *24H:* ${c24h}  |  *7D:* ${c7d}`,
    `*24H Volume:* ${volume}`,
    snapshot.marketCapRank ? `*Rank:* #${snapshot.marketCapRank}` : null,
    '',
    `_Fetched: ${new Date(snapshot.fetchedAt).toUTCString()}_`,
  ].filter(Boolean).join('\n');
}

// ─── Fear & Greed ─────────────────────────────────────────────────────────────

async function getFearGreed() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    const d   = await res.json();
    return {
      value: Number(d?.data?.[0]?.value || 0),
      label: d?.data?.[0]?.value_classification || 'Unknown',
    };
  } catch { return null; }
}

// ─── Spike alerts ─────────────────────────────────────────────────────────────

function addSpikeAlert(chatId, coinInput, threshold = DEFAULT_SPIKE_PERCENT) {
  const coinId = resolveCoinId(coinInput);
  const item   = {
    coinId,
    label:         String(coinInput).trim().toUpperCase().replace(/^\$/, ''),
    threshold:     Math.max(0.5, Number(threshold) || DEFAULT_SPIKE_PERCENT),
    lastPrice:     null,
    lastNotifiedAt: 0,
  };
  const alerts   = alertsByChat.get(chatId) || [];
  const filtered = alerts.filter(a => a.coinId !== coinId);
  filtered.push(item);
  alertsByChat.set(chatId, filtered);
  persistAlerts();
  return item;
}

function formatAlerts(chatId) {
  const alerts = alertsByChat.get(chatId) || [];
  if (!alerts.length) return `*No spike alerts yet.*\n\nUse /alert BTC 3 to watch for % moves.`;
  return [
    '*🔔 Active Spike Alerts*',
    '━━━━━━━━━━━━━━━━━━━━',
    ...alerts.map((a, i) => {
      const last = a.lastPrice ? `$${Number(a.lastPrice).toLocaleString('en-US')}` : 'waiting...';
      return `${i + 1}. *${a.label}* — ±${a.threshold}% — ${last}`;
    }),
  ].join('\n');
}

// ─── Watchlist ────────────────────────────────────────────────────────────────

function addToWatchlist(chatId, coinInput) {
  const coinId = resolveCoinId(coinInput);
  const label  = String(coinInput).trim().toUpperCase().replace(/^\$/, '');
  const list   = watchlistByChat.get(chatId) || [];
  if (!list.find(c => c.coinId === coinId)) {
    list.push({ coinId, label });
    watchlistByChat.set(chatId, list);
    persistWatchlist();
    return { added: true, label };
  }
  return { added: false, label };
}

function removeFromWatchlist(chatId, coinInput) {
  const coinId = resolveCoinId(coinInput);
  const list   = (watchlistByChat.get(chatId) || []).filter(c => c.coinId !== coinId);
  watchlistByChat.set(chatId, list);
  persistWatchlist();
}

async function formatWatchlist(chatId) {
  const list = watchlistByChat.get(chatId) || [];
  if (!list.length) return `*📋 Watchlist is empty.*\n\nUse /watch BTC to add coins.`;
  const lines = ['*📋 NEXUS Watchlist*', '━━━━━━━━━━━━━━━━━━━━'];
  for (const coin of list) {
    try {
      const snap  = await getCoinPriceSnapshot(coin.coinId);
      const price = Number.isFinite(snap.price) ? `$${snap.price.toLocaleString('en-US')}` : 'N/A';
      const c24h  = Number.isFinite(snap.change24h) ? `${snap.change24h > 0 ? '+' : ''}${snap.change24h.toFixed(2)}%` : 'N/A';
      const emoji = snap.change24h > 0 ? '🟢' : snap.change24h < 0 ? '🔴' : '⚪';
      lines.push(`${emoji} *${coin.label}* — ${price}  (${c24h})`);
    } catch { lines.push(`⚪ *${coin.label}* — price unavailable`); }
  }
  lines.push('');
  lines.push(`_Use /unwatch BTC to remove a coin_`);
  return lines.join('\n');
}

// ─── Analysis History ─────────────────────────────────────────────────────────

function addToHistory(chatId, analysis, marketContext) {
  const m     = analysis.metadata   || {};
  const s     = analysis.tradeSetup || {};
  const prob  = analysis.probability || {};
  const codex = analysis.codexAnalyst || {};
  const entry = {
    id:        Date.now(),
    timestamp: new Date().toISOString(),
    pair:      m.pair        || 'Unknown',
    timeframe: m.timeframe   || 'Unknown',
    price:     m.currentPrice || 'Unknown',
    exchange:  m.exchange    || 'Unknown',
    trend:     analysis.trend || 'neutral',
    direction: s.direction   || 'NO TRADE',
    entry:     s.entry       || null,
    stopLoss:  s.stopLoss    || null,
    tp1:       s.takeProfit1 || null,
    rr:        s.riskReward  || null,
    confidence: prob.confidence || analysis.confidence || 0,
    codexScore: codex.score  || 0,
    codexVerdict: codex.verdict || '',
    bullProb:  prob.bullish  || null,
    bearProb:  prob.bearish  || null,
    provider:  analysis.provider || 'AI',
    btcTrend:  marketContext?.trend || 'unknown',
  };

  const history = historyByChat.get(chatId) || [];
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.pop();
  historyByChat.set(chatId, history);
  persistHistory();
}

function formatHistory(chatId) {
  const history = historyByChat.get(chatId) || [];
  if (!history.length) return `*📜 No analysis history yet.*\n\nSend a chart screenshot to get started.`;

  const lines = ['*📜 NEXUS Analysis History*', '━━━━━━━━━━━━━━━━━━━━'];
  history.forEach((h, i) => {
    const te  = h.trend === 'bullish' ? '🟢' : h.trend === 'bearish' ? '🔴' : '🟡';
    const de  = h.direction.includes('BUY') || h.direction.includes('LONG') ? '📈' : h.direction.includes('SELL') || h.direction.includes('SHORT') ? '📉' : '⏸';
    const ago = Math.round((Date.now() - new Date(h.timestamp).getTime()) / 60000);
    const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago/60)}h ago` : `${Math.round(ago/1440)}d ago`;
    lines.push('');
    lines.push(`*${i + 1}. ${h.pair}* — ${h.timeframe}  _${agoStr}_`);
    lines.push(`  ${te} ${h.trend?.toUpperCase()}  |  ${de} ${h.direction}`);
    if (h.entry)   lines.push(`  Entry: \`${h.entry}\`  Stop: \`${h.stopLoss || 'N/A'}\``);
    if (h.tp1)     lines.push(`  TP1: \`${h.tp1}\`  R:R: ${h.rr || 'N/A'}:1`);
    lines.push(`  Codex: ${h.codexScore}/100  |  Conf: ${h.confidence}/100  |  ${h.provider}`);
  });
  return lines.join('\n');
}

// ─── Trade Journal ────────────────────────────────────────────────────────────

async function addJournalEntry(chatId, text) {
  // format: /journal add BTC long 103500
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const [, , coin, direction, entryPrice] = parts;
  if (!coin || !direction || !entryPrice) return null;

  const coinId  = resolveCoinId(coin);
  let currentPrice = null;
  try {
    const snap = await getCoinPriceSnapshot(coinId);
    currentPrice = snap.price;
  } catch {}

  const entry = {
    id:         Date.now(),
    timestamp:  new Date().toISOString(),
    coin:       coin.toUpperCase(),
    coinId,
    direction:  direction.toUpperCase(),
    entryPrice: Number(entryPrice),
    currentPrice,
    status:     'open',
    closedAt:   null,
    closePrice: null,
    pnlPercent: null,
  };

  const journal = journalByChat.get(chatId) || [];
  journal.unshift(entry);
  journalByChat.set(chatId, journal);
  persistJournal();
  return entry;
}

async function closeJournalEntry(chatId, tradeId, closePrice = null) {
  const journal = journalByChat.get(chatId) || [];
  const trade   = journal.find(t => t.id === tradeId && t.status === 'open');
  if (!trade) return null;

  let price = closePrice;
  if (!price) {
    try {
      const snap = await getCoinPriceSnapshot(trade.coinId);
      price = snap.price;
    } catch {}
  }

  trade.status     = 'closed';
  trade.closedAt   = new Date().toISOString();
  trade.closePrice = price;
  if (price && trade.entryPrice) {
    const pnl = ((price - trade.entryPrice) / trade.entryPrice) * 100;
    trade.pnlPercent = trade.direction === 'SHORT' ? -pnl : pnl;
  }
  journalByChat.set(chatId, journal);
  persistJournal();
  return trade;
}

async function formatJournal(chatId) {
  const journal = journalByChat.get(chatId) || [];
  if (!journal.length) return `*📓 Trade journal is empty.*\n\nUse:\n/journal add BTC long 103500\n/journal add ETH short 2800`;

  const open   = journal.filter(t => t.status === 'open');
  const closed = journal.filter(t => t.status === 'closed').slice(0, 5);
  const lines  = ['*📓 NEXUS Trade Journal*', '━━━━━━━━━━━━━━━━━━━━'];

  if (open.length) {
    lines.push('');
    lines.push('*Open Trades*');
    for (const t of open) {
      let currentPrice = t.currentPrice;
      try {
        const snap = await getCoinPriceSnapshot(t.coinId);
        currentPrice = snap.price;
        t.currentPrice = currentPrice;
      } catch {}
      const dir  = t.direction === 'LONG' || t.direction === 'BUY' ? '📈' : '📉';
      const ago  = Math.round((Date.now() - new Date(t.timestamp).getTime()) / 60000);
      const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago/60)}h ago` : `${Math.round(ago/1440)}d ago`;
      let pnlLine = '';
      if (currentPrice && t.entryPrice) {
        const pnl = ((currentPrice - t.entryPrice) / t.entryPrice) * 100;
        const adjPnl = (t.direction === 'SHORT' || t.direction === 'SELL') ? -pnl : pnl;
        const pnlStr = `${adjPnl >= 0 ? '+' : ''}${adjPnl.toFixed(2)}%`;
        pnlLine = `  P&L: *${pnlStr}* (Now: $${currentPrice.toLocaleString('en-US')})`;
      }
      lines.push(`${dir} *${t.coin}* ${t.direction} @ $${t.entryPrice.toLocaleString()}  _${agoStr}_`);
      if (pnlLine) lines.push(pnlLine);
      lines.push(`  ID: \`${t.id}\``);
    }
  }

  if (closed.length) {
    lines.push('');
    lines.push('*Recent Closed*');
    for (const t of closed) {
      const pnl    = t.pnlPercent;
      const emoji  = pnl != null ? (pnl >= 0 ? '✅' : '❌') : '⏹';
      const pnlStr = pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : 'N/A';
      lines.push(`${emoji} *${t.coin}* ${t.direction} — ${pnlStr}`);
    }
  }

  lines.push('');
  lines.push(`_/journal add BTC long 103500 — open a trade_`);
  lines.push(`_/journal close [ID] — close a trade_`);
  return lines.join('\n');
}

// ─── Daily Brief ──────────────────────────────────────────────────────────────

function parseTimeToMinutes(timeStr) {
  const match = String(timeStr || '').match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours   = Number(match[1]);
  const mins  = Number(match[2] || 0);
  const ampm  = (match[3] || '').toLowerCase();
  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  return hours * 60 + mins;
}

async function sendDailyBrief(chatId) {
  try {
    const [btcCtx, fg] = await Promise.all([
      getBitcoinMarketContext().catch(() => null),
      getFearGreed(),
    ]);

    const watchlist = watchlistByChat.get(chatId) || [];
    const lines = [
      `*☀️ NEXUS Daily Brief*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `_${new Date().toUTCString()}_`,
      '',
    ];

    if (btcCtx && btcCtx.trend !== 'unknown') {
      const i = btcCtx.intraday;
      lines.push(`*🟠 BTC Regime:* ${trendEmoji(btcCtx.trend)} ${btcCtx.trend?.toUpperCase()}`);
      lines.push(`  Price: $${i?.price?.toLocaleString() || 'N/A'}  |  RSI: ${i?.rsi || 'N/A'}`);
      lines.push(`  24h: ${btcCtx.higherTimeframe?.change != null ? btcCtx.higherTimeframe.change + '%' : 'N/A'}`);
      lines.push('');
    }

    if (fg) {
      const fgEmoji = fg.value >= 75 ? '🔥' : fg.value >= 55 ? '🟢' : fg.value >= 45 ? '🟡' : fg.value >= 25 ? '🔴' : '💀';
      lines.push(`*🧠 Fear & Greed:* ${fgEmoji} *${fg.value}* — ${fg.label}`);
      lines.push('');
    }

    if (watchlist.length) {
      lines.push(`*📋 Your Watchlist*`);
      for (const coin of watchlist.slice(0, 6)) {
        try {
          const snap  = await getCoinPriceSnapshot(coin.coinId);
          const price = Number.isFinite(snap.price) ? `$${snap.price.toLocaleString('en-US')}` : 'N/A';
          const c24h  = Number.isFinite(snap.change24h) ? `${snap.change24h > 0 ? '+' : ''}${snap.change24h.toFixed(2)}%` : 'N/A';
          const emoji = snap.change24h > 0 ? '🟢' : snap.change24h < 0 ? '🔴' : '⚪';
          lines.push(`  ${emoji} *${coin.label}* ${price}  ${c24h}`);
        } catch { lines.push(`  ⚪ *${coin.label}* —`); }
      }
      lines.push('');
    }

    lines.push(`_Send a chart screenshot to start today's analysis._`);
    await sendMessage(chatId, lines.join('\n'), { reply_markup: mainKeyboard() });
  } catch (err) {
    console.error(`[nexus] brief error for ${chatId}:`, err.message);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

async function handleSummary(chatId) {
  const msg = await sendMessage(chatId, '⏳ Building market summary...');
  try {
    const [btcCtx, fg] = await Promise.all([
      getBitcoinMarketContext().catch(() => null),
      getFearGreed(),
    ]);

    const watchlist = watchlistByChat.get(chatId) || [];
    const lines = [
      `*📊 NEXUS Market Summary*`,
      `━━━━━━━━━━━━━━━━━━━━`,
    ];

    if (btcCtx && btcCtx.trend !== 'unknown') {
      const i = btcCtx.intraday;
      lines.push(`*BTC:* ${trendEmoji(btcCtx.trend)} ${btcCtx.trend?.toUpperCase()} @ $${i?.price?.toLocaleString() || 'N/A'}`);
      lines.push(`  RSI: ${i?.rsi || 'N/A'}  |  Vol: ${i?.volumeState || 'N/A'}`);
    }

    if (fg) {
      const fgEmoji = fg.value >= 75 ? '🔥' : fg.value >= 55 ? '🟢' : fg.value >= 45 ? '🟡' : fg.value >= 25 ? '🔴' : '💀';
      lines.push(`*Fear & Greed:* ${fgEmoji} ${fg.value} — ${fg.label}`);
    }

    if (watchlist.length) {
      lines.push('');
      lines.push(`*Your Watchlist*`);
      for (const coin of watchlist.slice(0, 8)) {
        try {
          const snap  = await getCoinPriceSnapshot(coin.coinId);
          const price = Number.isFinite(snap.price) ? `$${snap.price.toLocaleString('en-US')}` : 'N/A';
          const c24h  = Number.isFinite(snap.change24h) ? `${snap.change24h > 0 ? '+' : ''}${snap.change24h.toFixed(2)}%` : '';
          const emoji = snap.change24h > 0 ? '🟢' : snap.change24h < 0 ? '🔴' : '⚪';
          lines.push(`  ${emoji} *${coin.label}* ${price}  ${c24h}`);
        } catch { lines.push(`  ⚪ *${coin.label}* —`); }
      }
    }

    lines.push('');
    lines.push(`_${new Date().toUTCString()}_`);
    await editMessage(chatId, msg.result.message_id, lines.join('\n'));
  } catch (err) {
    console.error('[nexus] summary error:', err.message);
    await editMessage(chatId, msg.result.message_id, '❌ Could not build summary. Try again.');
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleStart(chatId) {
  await sendMessage(chatId,
    `⚡ *Welcome to NEXUS*\n` +
    `_AI Trading Intelligence_\n\n` +
    `Send me a crypto chart screenshot for a full institutional-grade analysis:\n\n` +
    `• ICT/SMC structure — BOS, CHOCH, Order Blocks, FVGs\n` +
    `• Probability scenarios — Bull/Bear/Sideways %\n` +
    `• 3 take profit targets + stop loss + R:R\n` +
    `• RSI, MACD, Stoch RSI, volume divergence\n` +
    `• MA alignment + candle pattern recognition\n` +
    `• Live BTC regime + Fear & Greed context\n` +
    `• Codex risk score\n\n` +
    `*Commands:*\n` +
    `/btc — BTC regime + Fear & Greed\n` +
    `/price ETH — Price snapshot\n` +
    `/news BTC — Latest crypto news\n` +
    `/summary — Quick market overview\n` +
    `/history — Your last 5 analyses\n` +
    `/watch BTC — Add to watchlist\n` +
    `/watchlist — Live watchlist prices\n` +
    `/unwatch BTC — Remove from watchlist\n` +
    `/brief 8am — Daily auto-briefing\n` +
    `/journal add BTC long 103500 — Log a trade\n` +
    `/journal — View open trades with live P&L\n` +
    `/alert SOL 3 — Spike alert at ±3%\n` +
    `/alerts — Active alerts\n` +
    `/clearalerts — Remove all alerts\n\n` +
    `📊 Send a chart to begin.`,
    { reply_markup: mainKeyboard() }
  );
}

async function handleHelp(chatId) {
  await sendMessage(chatId,
    `*📖 NEXUS — Help*\n\n` +
    `*Getting analysis:*\n` +
    `1. Screenshot your chart (TradingView, Binance, Bybit, etc.)\n` +
    `2. Send the photo in this chat\n` +
    `3. Wait 15-45 seconds\n\n` +
    `*Best results tips:*\n` +
    `• Show RSI, MACD, and volume panels\n` +
    `• Keep price and timeframe labels visible\n` +
    `• One chart per message\n` +
    `• PNG or JPG, max 8MB\n\n` +
    `*All commands:*\n` +
    `/btc — BTC regime + Fear & Greed\n` +
    `/price BTC — Price snapshot\n` +
    `/news BTC — News & sentiment\n` +
    `/summary — Quick market overview\n` +
    `/history — Last 5 chart analyses\n` +
    `/watch BTC — Add to watchlist\n` +
    `/watchlist — Live watchlist\n` +
    `/unwatch BTC — Remove from watchlist\n` +
    `/brief 8am — Set daily briefing time\n` +
    `/brief off — Cancel daily briefing\n` +
    `/journal add BTC long 103500 — Log a trade\n` +
    `/journal close [ID] — Close a trade\n` +
    `/journal — View journal with live P&L\n` +
    `/alert ETH 3 — Alert on ±3% move\n` +
    `/alerts — Show alerts\n` +
    `/clearalerts — Clear all alerts\n` +
    `/start — Welcome`,
    { reply_markup: mainKeyboard() }
  );
}

async function handleBtc(chatId) {
  const msg = await sendMessage(chatId, '⏳ Fetching BTC data + Fear & Greed...');
  try {
    const [ctx, fg] = await Promise.all([getBitcoinMarketContext(), getFearGreed()]);
    await editMessage(chatId, msg.result.message_id, formatBtcSnapshot(ctx, fg));
  } catch (err) {
    console.error('[nexus] /btc error:', err.message);
    await editMessage(chatId, msg.result.message_id, '❌ Could not fetch BTC data. Try again.');
  }
}

async function handlePrice(chatId, text) {
  const parts = String(text || '').trim().split(/\s+/);
  const coin  = parts[1] || 'btc';
  const msg   = await sendMessage(chatId, `⏳ Fetching ${coin.toUpperCase()} price...`);
  try {
    const snapshot = await getCoinPriceSnapshot(coin);
    await editMessage(chatId, msg.result.message_id, formatPriceSnapshot(snapshot));
  } catch (err) {
    console.error('[nexus] /price error:', err.message);
    await editMessage(chatId, msg.result.message_id, `❌ Could not fetch that coin. Try: ${supportedCoinList()}`);
  }
}

async function handleNews(chatId, text) {
  const parts = String(text || '').trim().split(/\s+/);
  const coin  = parts[1] || 'bitcoin';
  const msg   = await sendMessage(chatId, `⏳ Fetching ${coin.toUpperCase()} news...`);
  try {
    const news = await fetchCryptoNews(coin, 5);
    await editMessage(chatId, msg.result.message_id, formatNewsDigest(news, coin.toUpperCase()));
  } catch (err) {
    console.error('[nexus] /news error:', err.message);
    await editMessage(chatId, msg.result.message_id, '❌ Could not fetch news. Try again.');
  }
}

async function handleWatch(chatId, text) {
  const parts = String(text || '').trim().split(/\s+/);
  const coin  = parts[1];
  if (!coin) {
    await sendMessage(chatId, `Send a coin: /watch BTC\n\nSupported: ${supportedCoinList()}`);
    return;
  }
  try {
    const { added, label } = addToWatchlist(chatId, coin);
    if (added) {
      await sendMessage(chatId, `✅ *${label}* added to your watchlist.`, { reply_markup: mainKeyboard() });
    } else {
      await sendMessage(chatId, `*${label}* is already on your watchlist.`, { reply_markup: mainKeyboard() });
    }
  } catch {
    await sendMessage(chatId, `❌ Unknown coin. Try: ${supportedCoinList()}`);
  }
}

async function handleUnwatch(chatId, text) {
  const parts = String(text || '').trim().split(/\s+/);
  const coin  = parts[1];
  if (!coin) { await sendMessage(chatId, 'Send a coin: /unwatch BTC'); return; }
  removeFromWatchlist(chatId, coin);
  await sendMessage(chatId, `✅ *${coin.toUpperCase()}* removed from watchlist.`, { reply_markup: mainKeyboard() });
}

async function handleWatchlist(chatId) {
  const msg = await sendMessage(chatId, '⏳ Fetching watchlist...');
  try {
    const text = await formatWatchlist(chatId);
    await editMessage(chatId, msg.result.message_id, text);
  } catch (err) {
    await editMessage(chatId, msg.result.message_id, '❌ Could not fetch watchlist.');
  }
}

async function handleHistory(chatId) {
  await sendMessage(chatId, formatHistory(chatId), { reply_markup: mainKeyboard() });
}

async function handleJournal(chatId, text) {
  const parts = String(text || '').trim().split(/\s+/);
  const sub   = (parts[1] || '').toLowerCase();

  if (sub === 'add') {
    const entry = await addJournalEntry(chatId, text.replace('/journal', '').trim());
    if (!entry) {
      await sendMessage(chatId,
        `❌ Format: /journal add BTC long 103500\n\nDirections: long, short, buy, sell`
      );
      return;
    }
    const price = entry.currentPrice ? `\nCurrent price: $${entry.currentPrice.toLocaleString('en-US')}` : '';
    await sendMessage(chatId,
      `✅ *${entry.coin} ${entry.direction}* logged at $${entry.entryPrice.toLocaleString()}${price}\n\nID: \`${entry.id}\`\nClose with: /journal close ${entry.id}`,
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (sub === 'close') {
    const tradeId = Number(parts[2]);
    const closePrice = parts[3] ? Number(parts[3]) : null;
    if (!tradeId) {
      await sendMessage(chatId, `❌ Format: /journal close [ID]\nGet the ID from /journal`);
      return;
    }
    const trade = await closeJournalEntry(chatId, tradeId, closePrice);
    if (!trade) {
      await sendMessage(chatId, `❌ Trade not found or already closed. Use /journal to see open trades.`);
      return;
    }
    const pnl    = trade.pnlPercent;
    const emoji  = pnl != null ? (pnl >= 0 ? '✅' : '❌') : '⏹';
    const pnlStr = pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : 'N/A';
    await sendMessage(chatId,
      `${emoji} *${trade.coin} ${trade.direction}* closed\n\nEntry: $${trade.entryPrice.toLocaleString()}\nClose: $${trade.closePrice?.toLocaleString() || 'N/A'}\nP&L: *${pnlStr}*`,
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  const text2 = await formatJournal(chatId);
  await sendMessage(chatId, text2, { reply_markup: mainKeyboard() });
}

async function handleBrief(chatId, text) {
  const parts   = String(text || '').trim().split(/\s+/);
  const timeArg = parts[1] || '';

  if (timeArg.toLowerCase() === 'off') {
    briefsByChat.delete(chatId);
    persistBriefs();
    await sendMessage(chatId, '✅ Daily briefing cancelled.', { reply_markup: mainKeyboard() });
    return;
  }

  const minutes = parseTimeToMinutes(timeArg);
  if (minutes === null) {
    await sendMessage(chatId, `❌ Format: /brief 8am or /brief 8:30am or /brief 14:00\n\nUse /brief off to cancel.`);
    return;
  }

  briefsByChat.set(chatId, { minutes, timeStr: timeArg });
  persistBriefs();
  await sendMessage(chatId,
    `✅ Daily briefing set for *${timeArg}* UTC.\n\nYou'll get BTC regime, Fear & Greed, and your watchlist prices every day at that time.\n\nUse /brief off to cancel.`,
    { reply_markup: mainKeyboard() }
  );
}

async function handleAlertCommand(chatId, text) {
  const parts   = String(text || '').trim().split(/\s+/);
  const coin    = parts[1];
  const percent = parts[2];
  if (!coin) {
    pendingByChat.set(chatId, 'alert');
    await sendMessage(chatId, `Send coin and threshold: BTC 3\n\nSupported: ${supportedCoinList()}`);
    return;
  }
  const alert = addSpikeAlert(chatId, coin, percent);
  await sendMessage(chatId,
    `✅ Spike alert set for *${alert.label}* at *±${alert.threshold}%*\nChecks every ${Math.round(ALERT_CHECK_MS / 1000)}s.`,
    { reply_markup: mainKeyboard() }
  );
}

async function handlePendingText(chatId, text) {
  const pending = pendingByChat.get(chatId);
  if (!pending) return false;
  pendingByChat.delete(chatId);

  if (pending === 'alert') {
    const [coin, percent] = String(text || '').trim().split(/\s+/);
    if (!coin) { await sendMessage(chatId, 'I need a coin symbol. Example: BTC 3'); return true; }
    const alert = addSpikeAlert(chatId, coin, percent);
    await sendMessage(chatId,
      `✅ Spike alert set for *${alert.label}* at *±${alert.threshold}%*`,
      { reply_markup: mainKeyboard() }
    );
    return true;
  }
  return false;
}

async function handleFeedback(chatId, messageId, type, queryId) {
  feedbackLog.push({ chatId, messageId, type, timestamp: new Date().toISOString() });
  if (feedbackLog.length > 1000) feedbackLog = feedbackLog.slice(-1000);
  await saveJson('feedback.json', feedbackLog);
  await answerCallback(queryId, type === 'good' ? '👍 Thanks for the feedback!' : '👎 Noted — we\'ll improve!');
}

async function handleCallback(query) {
  const chatId    = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data      = query.data || '';
  if (!chatId) return;

  if (data.startsWith('feedback:')) {
    const type = data.split(':')[1];
    await handleFeedback(chatId, messageId, type, query.id);
    return;
  }

  await answerCallback(query.id);

  if (data === 'btc')       { await handleBtc(chatId); return; }
  if (data === 'help')      { await handleHelp(chatId); return; }
  if (data === 'watchlist') { await handleWatchlist(chatId); return; }
  if (data === 'history')   { await handleHistory(chatId); return; }
  if (data === 'journal')   { await handleJournal(chatId, '/journal'); return; }
  if (data === 'summary')   { await handleSummary(chatId); return; }
  if (data === 'alerts') {
    await sendMessage(chatId, formatAlerts(chatId), { reply_markup: mainKeyboard() });
    return;
  }
  if (data === 'alert_menu') {
    pendingByChat.set(chatId, 'alert');
    await sendMessage(chatId, `Send coin and threshold: BTC 3\n\nQuick picks:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'BTC 3%', callback_data: 'quickalert:bitcoin:3' },
            { text: 'ETH 3%', callback_data: 'quickalert:ethereum:3' },
            { text: 'SOL 4%', callback_data: 'quickalert:solana:4' },
          ],
          [{ text: '« Back', callback_data: 'menu' }],
        ],
      },
    });
    return;
  }
  if (data === 'menu') {
    await sendMessage(chatId, '⚡ NEXUS controls:', { reply_markup: mainKeyboard() });
    return;
  }
  if (data.startsWith('price:')) {
    await handlePrice(chatId, `/price ${data.split(':')[1]}`);
    return;
  }
  if (data.startsWith('news:')) {
    await handleNews(chatId, `/news ${data.split(':')[1]}`);
    return;
  }
  if (data.startsWith('quickalert:')) {
    const [, coin, percent] = data.split(':');
    const alert = addSpikeAlert(chatId, coin, percent);
    pendingByChat.delete(chatId);
    await sendMessage(chatId, `✅ Alert set for *${alert.label}* at *±${alert.threshold}%*`, { reply_markup: mainKeyboard() });
    return;
  }

  if (messageId) await sendMessage(chatId, '⚡ Unknown button. Tap /start for the menu.');
}

async function handlePhoto(chatId, photo) {
  const fileId    = photo[photo.length - 1].file_id;
  const statusMsg = await sendMessage(chatId, '📥 Chart received — starting NEXUS analysis...\n_Takes 15–45 seconds._');
  const statusId  = statusMsg.result?.message_id;
  const filesToClean = [];
  const btcPromise   = getBitcoinMarketContext().catch(() => null);

  try {
    await editMessage(chatId, statusId, '⚙️ Preprocessing chart image...');
    const tmpPath = await downloadFile(fileId);
    filesToClean.push(tmpPath);

    const processed = await preprocessChartImage(tmpPath);
    filesToClean.push(processed.analysisPath, processed.ocrPath);

    await editMessage(chatId, statusId, '🔍 Running OCR & fetching BTC regime...');
    const [ocrText, marketContext] = await Promise.all([
      extractChartText(processed.ocrPath),
      btcPromise,
    ]);

    const payload = { mimeType: processed.mimeType, ocrText, marketContext, originalImage: processed.metadata };

    let analysis = await analyzeWithFallbacks(processed.analysisPath, payload, statusId, chatId);
    analysis = addCodexAnalyst(analysis, { ocrText, marketContext });

    const pair = analysis.metadata?.pair?.split('/')[0]?.toLowerCase() || 'bitcoin';
    await editMessage(chatId, statusId, '📰 Fetching news sentiment...');
    analysis = await analyzeWithNews(analysis, pair).catch(() => analysis);

    // Save to history
    addToHistory(chatId, analysis, marketContext);

    const report        = formatAnalysis(analysis, marketContext);
    const detectedPair  = analysis.metadata?.pair || '';

    await tgPost('deleteMessage', { chat_id: chatId, message_id: statusId });
    await sendMessage(chatId, report, { reply_markup: analysisKeyboard(detectedPair) });

  } catch (err) {
    console.error('[nexus] photo handler error:', err);
    const errText = err.statusCode === 503
      ? '⚠️ *All AI providers are temporarily busy.* Please retry in a moment.'
      : `❌ *Analysis failed.* ${err.publicMessage || err.message || 'Make sure the image is a clear chart screenshot.'}`;
    if (statusId) {
      await editMessage(chatId, statusId, errText).catch(() => sendMessage(chatId, errText));
    } else {
      await sendMessage(chatId, errText);
    }
  } finally {
    await Promise.all(filesToClean.map(p => fs.unlink(p).catch(() => {})));
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

let offset = 0;

async function poll() {
  try {
    const res  = await fetch(`${API}/getUpdates?timeout=25&offset=${offset}&allowed_updates=["message","callback_query"]`);
    const data = await res.json();
    if (!data.ok) { console.error('[nexus] getUpdates error:', data); return; }

    for (const update of data.result) {
      offset = update.update_id + 1;
      if (update.callback_query) { await handleCallback(update.callback_query); continue; }

      const msg = update.message;
      if (!msg) continue;
      const chatId = msg.chat.id;

      try {
        if (msg.photo) {
          await handlePhoto(chatId, msg.photo);
        } else if (msg.text) {
          if (await handlePendingText(chatId, msg.text)) continue;
          const cmd = msg.text.split(' ')[0].toLowerCase();
          if      (cmd === '/start')        await handleStart(chatId);
          else if (cmd === '/help')         await handleHelp(chatId);
          else if (cmd === '/btc')          await handleBtc(chatId);
          else if (cmd === '/price')        await handlePrice(chatId, msg.text);
          else if (cmd === '/news')         await handleNews(chatId, msg.text);
          else if (cmd === '/summary')      await handleSummary(chatId);
          else if (cmd === '/history')      await handleHistory(chatId);
          else if (cmd === '/watch')        await handleWatch(chatId, msg.text);
          else if (cmd === '/unwatch')      await handleUnwatch(chatId, msg.text);
          else if (cmd === '/watchlist')    await handleWatchlist(chatId);
          else if (cmd === '/brief')        await handleBrief(chatId, msg.text);
          else if (cmd === '/journal')      await handleJournal(chatId, msg.text);
          else if (cmd === '/alert')        await handleAlertCommand(chatId, msg.text);
          else if (cmd === '/alerts')       await sendMessage(chatId, formatAlerts(chatId), { reply_markup: mainKeyboard() });
          else if (cmd === '/clearalerts')  {
            alertsByChat.delete(chatId);
            persistAlerts();
            await sendMessage(chatId, '✅ All spike alerts cleared.', { reply_markup: mainKeyboard() });
          }
          else await sendMessage(chatId, '⚡ Send a chart screenshot or type /help.', { reply_markup: mainKeyboard() });
        }
      } catch (err) {
        console.error(`[nexus] handler error for chat ${chatId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[nexus] poll error:', err.message);
  }
  setImmediate(poll);
}

// ─── Spike alert checker ──────────────────────────────────────────────────────

async function checkSpikeAlerts() {
  for (const [chatId, alerts] of alertsByChat.entries()) {
    for (const alert of alerts) {
      try {
        const snapshot = await getCoinPriceSnapshot(alert.coinId);
        if (!Number.isFinite(snapshot.price)) continue;

        if (alert.lastPrice) {
          const move       = ((snapshot.price - alert.lastPrice) / alert.lastPrice) * 100;
          const absMove    = Math.abs(move);
          const cooledDown = Date.now() - alert.lastNotifiedAt > ALERT_CHECK_MS * 2;
          if (absMove >= alert.threshold && cooledDown) {
            alert.lastNotifiedAt = Date.now();
            const dir = move > 0 ? '🚀 UP' : '📉 DOWN';
            await sendMessage(chatId,
              `🚨 *${snapshot.symbol} Spike Alert — NEXUS*\n\n` +
              `${dir} *${absMove.toFixed(2)}%* since last check\n` +
              `Price: *$${snapshot.price.toLocaleString('en-US')}*\n` +
              `Threshold: ±${alert.threshold}%`,
              { reply_markup: mainKeyboard() }
            );
          }
        }
        alert.lastPrice = snapshot.price;
        alert.label     = snapshot.symbol;
      } catch (err) {
        console.error(`[nexus] alert check failed for ${alert.coinId}:`, err.message);
      }
    }
  }
}

// ─── Daily brief scheduler ────────────────────────────────────────────────────

async function checkDailyBriefs() {
  const now     = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const [chatId, brief] of briefsByChat.entries()) {
    if (brief.minutes === minutes) {
      await sendDailyBrief(chatId);
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

export async function startBot() {
  if (!TOKEN) {
    console.error('[nexus] TELEGRAM_BOT_TOKEN not set — bot will not start');
    return;
  }
  await loadAll();
  console.log('[nexus] NEXUS AI starting...');
  tgPost('getMe').then(info => {
    console.log(`[nexus] Connected as @${info.result?.username}`);
    if (!alertTimer) {
      alertTimer = setInterval(checkSpikeAlerts, ALERT_CHECK_MS);
      alertTimer.unref?.();
    }
    if (!briefTimer) {
      briefTimer = setInterval(checkDailyBriefs, BRIEF_CHECK_MS);
      briefTimer.unref?.();
    }
    poll();
  }).catch(err => {
    console.error('[nexus] Failed to connect to Telegram:', err.message);
  });
}
