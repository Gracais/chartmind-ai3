import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import fetch from 'node-fetch';

import { analyzeChart as analyzeChartGPT }      from './services/chatgpt.js';
import { analyzeChart as analyzeChartGemini }   from './services/gemini.js';
import { analyzeChartWithOpenRouter }            from './services/openrouter.js';
import { getBitcoinMarketContext }               from './services/marketData.js';
import { extractChartText }                      from './services/ocr.js';
import { preprocessChartImage }                  from './services/preprocess.js';
import { addCodexAnalyst }                       from './services/codexAnalyst.js';
import { getCoinPriceSnapshot, resolveCoinId, supportedCoinList } from './services/coinPrices.js';
import { analyzeWithNews, fetchCryptoNews, formatNewsDigest } from './services/news.js';

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const API      = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;
const ALERT_CHECK_MS        = Number(process.env.ALERT_CHECK_MS || 60_000);
const DEFAULT_SPIKE_PERCENT = Number(process.env.DEFAULT_SPIKE_PERCENT || 3);

const alertsByChat  = new Map();
const pendingByChat = new Map();
let alertTimer = null;

// ─── Telegram API helpers ────────────────────────────────────────────────────

async function tgPost(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'BTC Regime',  callback_data: 'btc' },
        { text: 'Price BTC',   callback_data: 'price:btc' },
        { text: 'Price ETH',   callback_data: 'price:eth' },
      ],
      [
        { text: '📰 News BTC', callback_data: 'news:bitcoin' },
        { text: '📰 News ETH', callback_data: 'news:ethereum' },
      ],
      [
        { text: 'Set Spike Alert', callback_data: 'alert_menu' },
        { text: 'My Alerts',       callback_data: 'alerts' },
        { text: 'Help',            callback_data: 'help' },
      ],
    ],
  };
}

async function answerCallback(callbackQueryId, text = '') {
  if (!callbackQueryId) return;
  await tgPost('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function sendMessage(chatId, text, extra = {}) {
  return tgPost('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...extra,
  });
}

async function editMessage(chatId, messageId, text) {
  return tgPost('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
  });
}

async function downloadFile(fileId) {
  const info = await fetch(`${API}/getFile?file_id=${fileId}`).then(r => r.json());
  if (!info.ok) throw new Error('Could not get file info from Telegram');
  const filePath = info.result.file_path;
  const ext      = path.extname(filePath) || '.jpg';
  const tmpPath  = path.join(os.tmpdir(), `cm_${Date.now()}${ext}`);
  const fileRes  = await fetch(`${FILE_API}/${filePath}`);
  const buffer   = await fileRes.arrayBuffer();
  await fs.writeFile(tmpPath, Buffer.from(buffer));
  return tmpPath;
}

// ─── AI provider chain: GPT → Gemini → OpenRouter ───────────────────────────

async function analyzeWithFallbacks(imagePath, payload, statusId, chatId) {
  const errors = [];

  // 1️⃣ GPT primary
  if (process.env.OPENAI_API_KEY) {
    try {
      await editMessage(chatId, statusId, '🤖 Analyzing chart with ChatGPT...');
      const result = await analyzeChartGPT(imagePath, payload);
      result.provider = 'ChatGPT';
      return result;
    } catch (err) {
      console.error('[bot] ChatGPT failed:', err.statusCode, err.message);
      errors.push(`GPT: ${err.message}`);
    }
  }

  // 2️⃣ Gemini fallback
  if (process.env.GEMINI_API_KEY) {
    try {
      await editMessage(chatId, statusId, '⚡ Switching to Gemini...');
      const result = await analyzeChartGemini(imagePath, payload);
      result.provider = 'Gemini';
      return result;
    } catch (err) {
      console.error('[bot] Gemini failed:', err.statusCode, err.message);
      errors.push(`Gemini: ${err.message}`);
    }
  }

  // 3️⃣ OpenRouter last resort
  if (process.env.OPENROUTER_API_KEY) {
    try {
      await editMessage(chatId, statusId, '⚡ Switching to OpenRouter...');
      const result = await analyzeChartWithOpenRouter(imagePath, payload);
      result.provider = result.provider || 'OpenRouter';
      return result;
    } catch (err) {
      console.error('[bot] OpenRouter failed:', err.statusCode, err.message);
      errors.push(`OpenRouter: ${err.message}`);
    }
  }

  console.error('[bot] All providers failed:', errors.join(' | '));
  throw Object.assign(new Error('All AI providers failed.'), {
    statusCode: 503,
    publicMessage: `All AI providers are currently unavailable. Please retry in a moment.`,
  });
}

// ─── Formatters ──────────────────────────────────────────────────────────────

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

function formatAnalysis(analysis, marketContext) {
  const m   = analysis.metadata || {};
  const s   = analysis.tradeSetup || {};
  const btc = marketContext?.intraday;
  const te  = trendEmoji(analysis.trend);
  const de  = directionEmoji(s.direction);
  const lines = [];

  lines.push(`*📊 ChartMind AI — Trading Desk Brief*`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`*Pair:* ${m.pair || 'Unknown'}`);
  lines.push(`*Timeframe:* ${m.timeframe || 'Unknown'}`);
  lines.push(`*Price:* ${m.currentPrice || 'Unknown'}`);
  lines.push(`*Exchange:* ${m.exchange || 'Unknown'}`);
  lines.push('');
  lines.push(`*Market Trend:* ${te} ${(analysis.trend || 'neutral').toUpperCase()}`);
  lines.push(`*Confidence:* ${analysis.confidence}/100`);
  if (analysis.marketStructure) lines.push(`${analysis.marketStructure}`);
  lines.push('');
  lines.push(`*${de} Setup: ${s.direction || 'NO TRADE'}*`);
  if (s.entry)        lines.push(`  Entry:        \`${s.entry}\``);
  if (s.stopLoss)     lines.push(`  Stop Loss:    \`${s.stopLoss}\``);
  if (s.takeProfit)   lines.push(`  Take Profit:  \`${s.takeProfit}\``);
  if (s.riskReward)   lines.push(`  R:R Ratio:    ${s.riskReward}`);
  if (s.invalidation) lines.push(`  Invalidation: ${s.invalidation}`);
  lines.push('');
  if (analysis.support?.length)    lines.push(`*Support:* ${analysis.support.join(' | ')}`);
  if (analysis.resistance?.length) lines.push(`*Resistance:* ${analysis.resistance.join(' | ')}`);
  if (analysis.support?.length || analysis.resistance?.length) lines.push('');
  if (analysis.rsi)  lines.push(`*RSI:* ${analysis.rsi}`);
  if (analysis.macd && analysis.macd !== 'Not visible') lines.push(`*MACD:* ${analysis.macd}`);
  if (analysis.volumeAnalysis && analysis.volumeAnalysis !== 'Not visible') {
    lines.push(`*Volume:* ${analysis.volumeAnalysis}`);
  }
  lines.push('');
  if (btc && marketContext?.trend !== 'unknown') {
    lines.push(`*BTC Regime:* ${trendEmoji(marketContext.trend)} ${marketContext.trend?.toUpperCase()}`);
    lines.push(`  Price: $${btc.price?.toLocaleString() || 'N/A'}  |  RSI: ${btc.rsi || 'N/A'}`);
    lines.push('');
  }
  lines.push(`*Summary*`);
  lines.push(analysis.summary || 'No summary.');
  lines.push('');
  if (analysis.warnings?.length) {
    lines.push(`⚠️ ${analysis.warnings.join('\n⚠️ ')}`);
    lines.push('');
  }
  if (analysis.codexAnalyst) {
    lines.push(`*Codex Second Opinion:* ${analysis.codexAnalyst.verdict}`);
    lines.push(`  Score: ${analysis.codexAnalyst.score}/100  |  BTC: ${analysis.codexAnalyst.alignment}`);
    if (analysis.codexAnalyst.note) lines.push(`  ${analysis.codexAnalyst.note}`);
    lines.push('');
  }
  if (analysis.provider) {
    lines.push(`_⚡ Analyzed by ${analysis.provider}_`);
  }
  if (analysis.degraded) {
    lines.push(`_⚠️ Fallback mode — retry for full analysis._`);
  }
  return lines.join('\n');
}

function formatBtcSnapshot(ctx) {
  if (!ctx || ctx.trend === 'unknown') {
    return '❌ *BTC market data unavailable right now.* Try again in a moment.';
  }
  const i  = ctx.intraday;
  const h  = ctx.higherTimeframe;
  const te = trendEmoji(ctx.trend);
  return [
    `*🟠 BTC Regime Snapshot*`,
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
    '',
    `_Fetched: ${new Date(ctx.fetchedAt).toUTCString()}_`,
  ].join('\n');
}

function formatPriceSnapshot(snapshot) {
  const price  = Number.isFinite(snapshot.price)    ? `$${snapshot.price.toLocaleString('en-US')}` : 'N/A';
  const c1h    = Number.isFinite(snapshot.change1h)  ? `${snapshot.change1h.toFixed(2)}%`  : 'N/A';
  const c24h   = Number.isFinite(snapshot.change24h) ? `${snapshot.change24h.toFixed(2)}%` : 'N/A';
  const c7d    = Number.isFinite(snapshot.change7d)  ? `${snapshot.change7d.toFixed(2)}%`  : 'N/A';
  const volume = Number.isFinite(snapshot.volume24h) ? `$${snapshot.volume24h.toLocaleString('en-US')}` : 'N/A';
  return [
    `*${snapshot.symbol} Price Snapshot*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*Name:* ${snapshot.name}`,
    `*Price:* ${price}`,
    `*1H:* ${c1h}`,
    `*24H:* ${c24h}`,
    `*7D:* ${c7d}`,
    `*24H Volume:* ${volume}`,
    snapshot.marketCapRank ? `*Rank:* #${snapshot.marketCapRank}` : null,
    '',
    `_Fetched: ${new Date(snapshot.fetchedAt).toUTCString()}_`,
  ].filter(Boolean).join('\n');
}

function addSpikeAlert(chatId, coinInput, threshold = DEFAULT_SPIKE_PERCENT) {
  const coinId = resolveCoinId(coinInput);
  const item = {
    coinId,
    label: String(coinInput).trim().toUpperCase().replace(/^\$/, ''),
    threshold: Math.max(0.5, Number(threshold) || DEFAULT_SPIKE_PERCENT),
    lastPrice: null,
    lastNotifiedAt: 0,
  };
  const alerts   = alertsByChat.get(chatId) || [];
  const filtered = alerts.filter(a => a.coinId !== coinId);
  filtered.push(item);
  alertsByChat.set(chatId, filtered);
  return item;
}

function formatAlerts(chatId) {
  const alerts = alertsByChat.get(chatId) || [];
  if (!alerts.length) {
    return `*No spike alerts yet.*\n\nUse /alert BTC 3 or tap *Set Spike Alert* to watch for a percentage move between checks.`;
  }
  return [
    '*Active Spike Alerts*',
    '━━━━━━━━━━━━━━━━━━━━',
    ...alerts.map((alert, i) => {
      const last = alert.lastPrice ? `$${Number(alert.lastPrice).toLocaleString('en-US')}` : 'waiting for first check';
      return `${i + 1}. *${alert.label}* — ${alert.threshold}% move/check — ${last}`;
    }),
  ].join('\n');
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleStart(chatId) {
  await sendMessage(chatId,
    `👋 *Welcome to ChartMind AI*\n\n` +
    `Send me a crypto chart screenshot and I'll give you a full institutional-grade analysis:\n\n` +
    `• Market trend & structure\n` +
    `• Support & resistance levels\n` +
    `• Trade setup (entry, stop, target)\n` +
    `• RSI, MACD, volume read\n` +
    `• Live BTC regime context\n\n` +
    `*Commands:*\n` +
    `/btc — Live BTC market snapshot\n` +
    `/price ETH — Price snapshot\n` +
    `/news BTC — Latest crypto news\n` +
    `/alert SOL 3 — Spike alert at 3% moves\n` +
    `/alerts — Active alerts\n` +
    `/clearalerts — Remove alerts\n` +
    `/help — Usage tips\n\n` +
    `Just send a chart photo to get started. 📊`,
    { reply_markup: mainKeyboard() }
  );
}

async function handleHelp(chatId) {
  await sendMessage(chatId,
    `*📖 How to use ChartMind AI*\n\n` +
    `1. Screenshot your chart (TradingView, Binance, Bybit, etc.)\n` +
    `2. Send the photo directly in this chat\n` +
    `3. Wait ~15-30 seconds for analysis\n\n` +
    `*Tips for best results:*\n` +
    `• Include visible indicators (RSI, MACD, MAs)\n` +
    `• Make sure price labels and timeframe are visible\n` +
    `• One chart per message\n` +
    `• PNG or JPG, max 8MB\n\n` +
    `*Commands:*\n` +
    `/btc — BTC regime snapshot\n` +
    `/price BTC — Coin price snapshot\n` +
    `/news BTC — Latest news & sentiment\n` +
    `/alert ETH 3 — Alert if ETH moves 3% between checks\n` +
    `/alerts — Show active alerts\n` +
    `/clearalerts — Clear your alerts\n` +
    `/start — Welcome message`,
    { reply_markup: mainKeyboard() }
  );
}

async function handleBtc(chatId) {
  const msg = await sendMessage(chatId, '⏳ Fetching live BTC data...');
  try {
    const ctx = await getBitcoinMarketContext();
    await editMessage(chatId, msg.result.message_id, formatBtcSnapshot(ctx));
  } catch (err) {
    console.error('[bot] /btc error:', err.message);
    await editMessage(chatId, msg.result.message_id, '❌ Could not fetch BTC data. Try again.');
  }
}

async function handlePrice(chatId, text) {
  const [, coin = 'btc'] = String(text || '').trim().split(/\s+/);
  const msg = await sendMessage(chatId, `⏳ Fetching ${coin.toUpperCase()} price...`);
  try {
    const snapshot = await getCoinPriceSnapshot(coin);
    await editMessage(chatId, msg.result.message_id, formatPriceSnapshot(snapshot));
  } catch (err) {
    console.error('[bot] /price error:', err.message);
    await editMessage(chatId, msg.result.message_id, `❌ Could not fetch that coin. Try one of: ${supportedCoinList()}`);
  }
}

async function handleNews(chatId, text) {
  const [, coin = 'bitcoin'] = String(text || '').trim().split(/\s+/);
  const msg = await sendMessage(chatId, `⏳ Fetching ${coin.toUpperCase()} news...`);
  try {
    const news = await fetchCryptoNews(coin, 5);
    await editMessage(chatId, msg.result.message_id, formatNewsDigest(news, coin.toUpperCase()));
  } catch (err) {
    console.error('[bot] /news error:', err.message);
    await editMessage(chatId, msg.result.message_id, '❌ Could not fetch news. Try again.');
  }
}

async function handleAlertCommand(chatId, text) {
  const [, coin, percent] = String(text || '').trim().split(/\s+/);
  if (!coin) {
    pendingByChat.set(chatId, 'alert');
    await sendMessage(chatId, `Send the alert as: BTC 3\n\nSupported quick symbols: ${supportedCoinList()}`);
    return;
  }
  const alert = addSpikeAlert(chatId, coin, percent);
  await sendMessage(chatId,
    `✅ Spike alert set for *${alert.label}* at *${alert.threshold}%* moves between checks.\n\nI check about every ${Math.round(ALERT_CHECK_MS / 1000)} seconds.`,
    { reply_markup: mainKeyboard() }
  );
}

async function handlePendingText(chatId, text) {
  const pending = pendingByChat.get(chatId);
  if (!pending) return false;
  pendingByChat.delete(chatId);

  if (pending === 'alert') {
    const [coin, percent] = String(text || '').trim().split(/\s+/);
    if (!coin) {
      await sendMessage(chatId, 'I need a coin symbol. Example: BTC 3');
      return true;
    }
    const alert = addSpikeAlert(chatId, coin, percent);
    await sendMessage(chatId,
      `✅ Spike alert set for *${alert.label}* at *${alert.threshold}%* moves between checks.`,
      { reply_markup: mainKeyboard() }
    );
    return true;
  }

  return false;
}

async function handleCallback(query) {
  const chatId    = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data      = query.data || '';
  if (!chatId) return;
  await answerCallback(query.id);

  if (data === 'btc')    { await handleBtc(chatId); return; }
  if (data === 'help')   { await handleHelp(chatId); return; }
  if (data === 'alerts') {
    await sendMessage(chatId, formatAlerts(chatId), { reply_markup: mainKeyboard() });
    return;
  }
  if (data === 'alert_menu') {
    pendingByChat.set(chatId, 'alert');
    await sendMessage(chatId, `Send coin and threshold like: BTC 3\n\nI will alert on fast percentage moves between checks.`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'BTC 3%', callback_data: 'quickalert:btc:3' },
            { text: 'ETH 3%', callback_data: 'quickalert:eth:3' },
            { text: 'SOL 4%', callback_data: 'quickalert:sol:4' },
          ],
          [{ text: 'Back', callback_data: 'menu' }],
        ],
      },
    });
    return;
  }
  if (data === 'menu') {
    await sendMessage(chatId, 'ChartMind controls:', { reply_markup: mainKeyboard() });
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
    await sendMessage(chatId, `✅ Spike alert set for *${alert.label}* at *${alert.threshold}%*.`, {
      reply_markup: mainKeyboard(),
    });
    return;
  }

  if (messageId) await sendMessage(chatId, 'Unknown button. Tap /start for the menu.');
}

async function handlePhoto(chatId, photo) {
  const fileId    = photo[photo.length - 1].file_id;
  const statusMsg = await sendMessage(chatId, '📥 Chart received — starting analysis...\n_This takes 15–45 seconds on first run._');
  const statusId  = statusMsg.result?.message_id;
  const filesToClean = [];

  const btcPromise = getBitcoinMarketContext().catch(() => null);

  try {
    await editMessage(chatId, statusId, '⚙️ Downloading & preprocessing chart...');
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

    // GPT → Gemini → OpenRouter
    let analysis = await analyzeWithFallbacks(processed.analysisPath, payload, statusId, chatId);
    analysis = addCodexAnalyst(analysis, { ocrText, marketContext });

    // News sentiment enrichment
    const pair = analysis.metadata?.pair?.split('/')[0]?.toLowerCase() || 'bitcoin';
    await editMessage(chatId, statusId, '📰 Fetching news sentiment...');
    analysis = await analyzeWithNews(analysis, pair).catch(() => analysis);

    const report = formatAnalysis(analysis, marketContext);
    await tgPost('deleteMessage', { chat_id: chatId, message_id: statusId });
    await sendMessage(chatId, report);

  } catch (err) {
    console.error('[bot] photo handler error:', err);
    const errText = err.statusCode === 503
      ? '⚠️ *All AI providers are temporarily busy.* Please retry in a moment.'
      : `❌ *Analysis failed.* ${err.publicMessage || err.message || 'Make sure the image is a clear chart screenshot and try again.'}`;
    if (statusId) {
      await editMessage(chatId, statusId, errText).catch(() => sendMessage(chatId, errText));
    } else {
      await sendMessage(chatId, errText);
    }
  } finally {
    await Promise.all(filesToClean.map(p => fs.unlink(p).catch(() => {})));
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

let offset = 0;

async function poll() {
  try {
    const res  = await fetch(`${API}/getUpdates?timeout=25&offset=${offset}&allowed_updates=["message","callback_query"]`);
    const data = await res.json();

    if (!data.ok) { console.error('[bot] getUpdates error:', data); return; }

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
          if      (cmd === '/start')       await handleStart(chatId);
          else if (cmd === '/help')        await handleHelp(chatId);
          else if (cmd === '/btc')         await handleBtc(chatId);
          else if (cmd === '/price')       await handlePrice(chatId, msg.text);
          else if (cmd === '/news')        await handleNews(chatId, msg.text);
          else if (cmd === '/alert')       await handleAlertCommand(chatId, msg.text);
          else if (cmd === '/alerts')      await sendMessage(chatId, formatAlerts(chatId), { reply_markup: mainKeyboard() });
          else if (cmd === '/clearalerts') {
            alertsByChat.delete(chatId);
            await sendMessage(chatId, '✅ Cleared your spike alerts.', { reply_markup: mainKeyboard() });
          }
          else await sendMessage(chatId, '📊 Send me a chart screenshot, use the buttons, or type /help.', { reply_markup: mainKeyboard() });
        }
      } catch (err) {
        console.error(`[bot] handler error for chat ${chatId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[bot] poll error:', err.message);
  }

  setImmediate(poll);
}

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
            const direction = move > 0 ? 'up' : 'down';
            await sendMessage(chatId,
              `🚨 *${snapshot.symbol} Spike Alert*\n\n` +
              `${snapshot.symbol} moved *${direction} ${absMove.toFixed(2)}%* since the last check.\n` +
              `Price: *$${snapshot.price.toLocaleString('en-US')}*\n` +
              `Threshold: ${alert.threshold}%`,
              { reply_markup: mainKeyboard() }
            );
          }
        }

        alert.lastPrice = snapshot.price;
        alert.label     = snapshot.symbol;
      } catch (err) {
        console.error(`[bot] alert check failed for ${alert.coinId}:`, err.message);
      }
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

export function startBot() {
  if (!TOKEN) {
    console.error('[bot] TELEGRAM_BOT_TOKEN not set — bot will not start');
    return;
  }
  console.log('[bot] ChartMind AI Telegram bot starting...');
  tgPost('getMe').then(info => {
    console.log(`[bot] Connected as @${info.result?.username}`);
    if (!alertTimer) {
      alertTimer = setInterval(checkSpikeAlerts, ALERT_CHECK_MS);
      alertTimer.unref?.();
    }
    poll();
  }).catch(err => {
    console.error('[bot] Failed to connect to Telegram:', err.message);
  });
}
