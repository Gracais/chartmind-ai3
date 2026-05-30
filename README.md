# ChartMind AI — v3

A Node.js crypto chart analysis app running as both a **web app** and **Telegram bot**.

## What's new in v3

### 1. AI Fallback Chain — Gemini → OpenRouter → Fallback Report
If Gemini hits rate limits or goes down, ChartMind automatically switches to
**OpenRouter** free-tier vision models (Gemini Flash Exp, Llama 4 Maverick, Mistral).
If both fail, a structured fallback report is returned with the BTC context still intact.

The web UI shows a coloured pill (green = Gemini, amber = OpenRouter, red = fallback).
The Telegram bot shows "⚡ switching to fallback AI..." during handoff.

### 2. BTC Data Caching — near-instant on repeat requests
BTC market context is now cached for 90 seconds (configurable via `BTC_CACHE_TTL_MS`).
- First request: fetches live from Binance → Bybit → CoinGecko as before
- All requests within 90s: served from cache in <1ms
- Concurrent requests: deduplicated — one fetch, all callers get the same result
- The web UI pre-warms the BTC cache on page load so it's ready before you hit Analyze

### 3. Faster parallel pipeline
Previously: upload → preprocess → OCR → BTC fetch → Gemini
Now: BTC fetch races in parallel with image preprocessing so BTC is usually
already done by the time the image is ready. Combined with caching, this
cuts typical latency by 5-15 seconds.

### 4. Dedicated `/btc` endpoint
`GET /btc` returns live (or cached) BTC market data without an image upload.
Used by the page pre-warm and available for any other integrations.

### 5. Telegram buttons + spike alerts
The Telegram bot now opens with inline buttons for BTC regime, quick BTC/ETH
prices, alert setup, active alerts, and help.

Commands:
```
/price ETH       # Price snapshot from CoinGecko
/alert SOL 4     # Alert when SOL moves 4% between checks
/alerts          # Show active spike alerts
/clearalerts     # Remove your alerts
```

Spike alerts are in-memory and reset when the Node process restarts. For
production persistence, back `alertsByChat` with Redis, SQLite, or Postgres.

## Stack
- **Express** — web server
- **Gemini API** — visual chart analysis (primary)
- **OpenRouter** — AI fallback (free tier, vision-capable models)
- **Binance → Bybit → CoinGecko** — live BTC market data (3-provider fallback chain)
- **Tesseract.js** — OCR
- **Sharp** — image preprocessing
- **Telegram Bot API** — long-polling bot

## File structure
```
├── server.js               # Entry point — web server + bot
├── bot.js                  # Telegram bot (exported as startBot())
├── index.html              # Web UI
├── routes/
│   ├── analyze.js          # POST /analyze — full analysis pipeline
│   └── btc.js              # GET /btc     — live BTC snapshot (cached)
└── services/
    ├── gemini.js           # Gemini API (primary AI)
    ├── openrouter.js       # OpenRouter API (fallback AI)  ← NEW
    ├── codexAnalyst.js     # Codex risk audit / second opinion
    ├── coinPrices.js       # CoinGecko price snapshots for bot alerts
    ├── marketData.js       # BTC data + in-memory cache    ← UPDATED
    ├── ocr.js              # Tesseract OCR
    └── preprocess.js       # Sharp image pipeline
```

## Environment variables
```
# Required
GEMINI_API_KEY=AIzaSy...          # from aistudio.google.com
TELEGRAM_BOT_TOKEN=7123...        # from @BotFather

# Required for fallback (free — no credit card)
OPENROUTER_API_KEY=sk-or-...      # from openrouter.ai/keys
```

Optional:
```
OPENROUTER_MODELS=google/gemini-2.0-flash-exp:free,meta-llama/llama-4-maverick:free,...
OPENROUTER_TIMEOUT_MS=40000
BTC_CACHE_TTL_MS=90000            # How long to cache BTC data (default 90s)
GEMINI_MODELS=gemini-2.5-flash,gemini-2.0-flash,gemini-2.0-flash-lite
GEMINI_TIMEOUT_MS=35000
BTC_FETCH_BUDGET_MS=15000         # Max wait for BTC before proceeding without it
MARKET_TIMEOUT_MS=50000
MAX_UPLOAD_MB=8
PORT=3000
```

## How to run
```bash
npm install
node server.js
```

## Getting your OpenRouter key
1. Go to https://openrouter.ai/keys
2. Sign up (free, no credit card needed)
3. Create a key and add it to `.env` as `OPENROUTER_API_KEY`
4. Free models that support vision: https://openrouter.ai/models?q=free&modality=image
