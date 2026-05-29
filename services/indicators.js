import { RSI, EMA, MACD } from 'technicalindicators';

export function calculateIndicators(closes = []) {

  if (closes.length < 30) {
    return {
      error: 'Not enough candle data'
    };
  }

  const rsi = RSI.calculate({
    values: closes,
    period: 14
  });

  const ema20 = EMA.calculate({
    values: closes,
    period: 20
  });

  const ema50 = EMA.calculate({
    values: closes,
    period: 50
  });

  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  return {
    rsi: rsi.at(-1),
    ema20: ema20.at(-1),
    ema50: ema50.at(-1),
    macd: macd.at(-1)
  };
}
