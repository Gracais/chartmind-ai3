// GET /btc — returns live BTC market context (cached, very fast on repeat calls)
import express from 'express';
import { getBitcoinMarketContext } from '../services/marketData.js';

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const ctx = await getBitcoinMarketContext();
    return res.json({ success: true, data: ctx });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: { code: 'BTC_UNAVAILABLE', message: 'BTC market data is temporarily unavailable.' },
    });
  }
});

export default router;
