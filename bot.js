/**
 * ChartMind AI — Telegram Bot
 * 
 * Commands:
 *   /start   — welcome message
 *   /help    — usage instructions
 *   /btc     — live BTC regime snapshot (no image needed)
 * 
 * Send any photo → full chart analysis
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import fetch from 'node-fetch';

import { analyzeChart }               from './services/gemini.js';
import { analyzeChartWithOpenRouter } from './services/openrouter.js';
import { getBitcoinMarketContext } from './services/marketData.js';
import { extractChartText }     from './services/ocr.js';
import { preprocessChartImage } from './services/preprocess.js';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const API     = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

// ─── Telegram API helpers ────────────────────────────────────────────────────

async function tgPost(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
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
  // Get file path from Telegram
  const info = await fetch(`${API}/getFile?file_id=${fileId}`).then(r => r.json());
  if (!info.ok) throw new Error('Could not get file info from Telegram');
  
  const filePath = info.result.file_path;
  const ext      = path.extname(filePath) || '.jpg';
  const tmpPath  = path.join(os.tmpdir(), `cm_${Date.now()}${ext}`);

  // Download the actual file
  const fileRes  = await fetch(`${FILE_API}/${filePath}`);
  const buffer   = await fileRes.arrayBuffer();
  await fs.writeFile(tmpPath, Buffer.from(buffer));
  return tmpPath;
}

// ─── Format analysis into readable Telegram message ─────────────────────────

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
  if (d.includes('LONG'))  return '📈';
  if (d.includes('SHORT')) return '📉';
  return '⏸';
}

function formatAnalysis(analysis, marketContext) {
  const m   = analysis.metadata || {};
  const s   = analysis.tradeSetup || {};
  const btc = marketContext?.intraday;
  const te  = trendEmoji(analysis.trend);
  const de  = directionEmoji(s.direction);

  const lines = [];

  // Header
  lines.push(`*📊 ChartMind AI — Trading Desk Brief*`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  // Metadata
  lines.push(`*Pair:* ${m.pair || 'Unknown'}`);
  lines.push(`*Timeframe:* ${m.timeframe || 'Unknown'}`);
  lines.push(`*Price:* ${m.currentPrice || 'Unknown'}`);
  lines.push(`*Exchange:* ${m.exchange || 'Unknown'}`);
  lines.push('');

  // Market trend
  lines.push(`*Market Trend:* ${te} ${(analysis.trend || 'neutral').toUpperCase()}`);
  lines.push(`*Confidence:* ${analysis.confidence}/100`);
  if (analysis.marketStructure) lines.push(`${analysis.marketStructure}`);
  lines.push('');

  // Trade setup
  lines.push(`*${de} Setup: ${s.direction || 'NO TRADE'}*`);
  if (s.entry)      lines.push(`  Entry:       \`${s.entry}\``);
  if (s.stopLoss)   lines.push(`  Stop Loss:   \`${s.stopLoss}\``);
  if (s.takeProfit) lines.push(`  Take Profit: \`${s.takeProfit}\``);
  if (s.riskReward) lines.push(`  R:R Ratio:   ${s.riskReward}`);
  if (s.invalidation) lines.push(`  Invalidation: ${s.invalidation}`);
  lines.push('');

  // Key levels
  if (analysis.support?.length)    lines.push(`*Support:* ${analysis.support.join(' | ')}`);
  if (analysis.resistance?.length) lines.push(`*Resistance:* ${analysis.resistance.join(' | ')}`);
  if (analysis.support?.length || analysis.resistance?.length) lines.push('');

  // Indicators
  if (analysis.rsi)  lines.push(`*RSI:* ${analysis.rsi}`);
  if (analysis.macd && analysis.macd !== 'Not visible') lines.push(`*MACD:* ${analysis.macd}`);
  if (analysis.volumeAnalysis && analysis.volumeAnalysis !== 'Not visible') {
    lines.push(`*Volume:* ${analysis.volumeAnalysis}`);
  }
  lines.push('');

  // BTC context
  if (btc && marketContext?.trend !== 'unknown') {
    lines.push(`*BTC Regime:* ${trendEmoji(marketContext.trend)} ${marketContext.trend?.toUpperCase()}`);
    lines.push(`  Price: $${btc.price?.toLocaleString() || 'N/A'}  |  RSI: ${btc.rsi || 'N/A'}`);
    lines.push('');
  }

  // Summary
  lines.push(`*Summary*`);
  lines.push(analysis.summary || 'No summary.');
  lines.push('');

  // Warnings
  if (analysis.warnings?.length) {
    lines.push(`⚠️ ${analysis.warnings.join('\n⚠️ ')}`);
    lines.push('');
  }

  // Degraded notice
  if (analysis.degraded) {
    lines.push(`_⚡ Fallback mode — Gemini unavailable. Retry for full analysis._`);
  }

  return lines.join('\n');
}

function formatBtcSnapshot(ctx) {
  if (!ctx || ctx.trend === 'unknown') {
    return '❌ *BTC market data unavailable right now.* Try again in a moment.';
  }
  const i = ctx.intraday;
  const h = ctx.higherTimeframe;
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
    `/help — Usage tips\n\n` +
    `Just send a chart photo to get started. 📊`
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
    `/btc — BTC regime snapshot (no image needed)\n` +
    `/start — Welcome message`
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

async function handlePhoto(chatId, photo) {
  // Telegram sends multiple sizes — take the largest (last)
  const fileId = photo[photo.length - 1].file_id;

  const statusMsg = await sendMessage(chatId, '📥 Chart received — starting analysis...\n_This takes 15–45 seconds on first run._');
  const statusId  = statusMsg.result?.message_id;

  const filesToClean = [];

  // Kick off BTC fetch immediately
  const btcPromise = getBitcoinMarketContext().catch(() => null);

  let tmpPath = null;
  try {
    await editMessage(chatId, statusId, '⚙️ Downloading & preprocessing chart...');
    tmpPath = await downloadFile(fileId);
    filesToClean.push(tmpPath);

    const processed = await preprocessChartImage(tmpPath);
    filesToClean.push(processed.analysisPath, processed.ocrPath);

    await editMessage(chatId, statusId, '🔍 Running OCR & fetching BTC regime...');
    const [ocrText, marketContext] = await Promise.all([
      extractChartText(processed.ocrPath),
      btcPromise,
    ]);

    await editMessage(chatId, statusId, '🤖 Analyzing chart with AI...');
    let analysis;
    try {
      analysis = await analyzeChart(processed.analysisPath, {
        mimeType: processed.mimeType, ocrText, marketContext, originalImage: processed.metadata,
      });
    } catch (geminiErr) {
      const isTransient = geminiErr.retryable !== false || geminiErr.statusCode >= 500;
      if (!isTransient) throw geminiErr;
      console.error('[bot] Gemini failed, trying OpenRouter fallback:', geminiErr.message);
      await editMessage(chatId, statusId, '⚡ Gemini busy — switching to fallback AI...');
      analysis = await analyzeChartWithOpenRouter(processed.analysisPath, {
        mimeType: processed.mimeType, ocrText, marketContext, originalImage: processed.metadata,
      });
    }

    const report = formatAnalysis(analysis, marketContext);

    // Delete the status message, send the real report
    await tgPost('deleteMessage', { chat_id: chatId, message_id: statusId });
    await sendMessage(chatId, report);

  } catch (err) {
    console.error('[bot] photo handler error:', err);
    const errText = err.statusCode === 503
      ? '⚠️ *Both AI providers are temporarily busy.* Your chart processed fine — please retry in a moment.'
      : '❌ *Analysis failed.* Make sure the image is a clear chart screenshot and try again.';
    if (statusId) {
      await editMessage(chatId, statusId, errText).catch(() => sendMessage(chatId, errText));
    } else {
      await sendMessage(chatId, errText);
    }
  } finally {
    // Delete all temp files immediately
    await Promise.all(filesToClean.map(p => fs.unlink(p).catch(() => {})));
  }
}

// ─── Polling loop ────────────────────────────────────────────────────────────

let offset = 0;

async function poll() {
  try {
    const res  = await fetch(`${API}/getUpdates?timeout=25&offset=${offset}&allowed_updates=["message"]`);
    const data = await res.json();

    if (!data.ok) {
      console.error('[bot] getUpdates error:', data);
      return;
    }

    for (const update of data.result) {
      offset = update.update_id + 1;
      const msg    = update.message;
      if (!msg) continue;
      const chatId = msg.chat.id;

      try {
        if (msg.photo) {
          await handlePhoto(chatId, msg.photo);
        } else if (msg.text) {
          const cmd = msg.text.split(' ')[0].toLowerCase();
          if (cmd === '/start')      await handleStart(chatId);
          else if (cmd === '/help')  await handleHelp(chatId);
          else if (cmd === '/btc')   await handleBtc(chatId);
          else await sendMessage(chatId, '📊 Send me a chart screenshot to analyze it, or type /help for instructions.');
        }
      } catch (err) {
        console.error(`[bot] handler error for chat ${chatId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[bot] poll error:', err.message);
  }

  // Keep polling
  setImmediate(poll);
}

// ─── Start ───────────────────────────────────────────────────────────────────

console.log('[bot] ChartMind AI Telegram bot starting...');
tgPost('getMe').then(info => {
  console.log(`[bot] Connected as @${info.result?.username}`);
  poll();
}).catch(err => {
  console.error('[bot] Failed to connect to Telegram:', err.message);
  process.exit(1);
});
