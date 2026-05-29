# ChartMind AI 2.0

Professional AI trading copilot for chart screenshot analysis.

## Features

- Structured institutional-style technical analysis
- Sharp image preprocessing for resizing, contrast enhancement, OCR optimization, and compression
- Tesseract OCR chart text extraction with timeout handling
- Gemini JSON analysis contract
- Upload validation, image size limits, and user-friendly frontend/API errors
- RSI/MACD-ready indicator engine
- Trade setup normalization with entry, stop loss, take profit, risk/reward, confidence, and warnings
- Gemini AI integration
- Live BTC regime context from Binance public market data with CoinGecko fallback
- Future-ready hooks for Telegram, Discord, TradingView, voice, annotations, memory, journal, and dashboards

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Environment Variables

Create a `.env` file:

```env
GEMINI_API_KEY=your_api_key_here
PORT=3000
MAX_UPLOAD_MB=8
GEMINI_MODELS=gemini-2.5-flash,gemini-flash-latest,gemini-2.0-flash-lite
GEMINI_TIMEOUT_MS=35000
MARKET_TIMEOUT_MS=6000
```

## API

POST `/analyze`

FormData:

- image

Returns:

- `success`
- `data.analysis.trend`
- `data.analysis.support`
- `data.analysis.resistance`
- `data.analysis.rsi`
- `data.analysis.macd`
- `data.analysis.tradeSetup`
- `data.analysis.confidence`
- `data.analysis.warnings`
- `data.ocrText`
- `data.marketContext`
- `data.preprocessing`
