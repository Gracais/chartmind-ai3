export function scoreTrade({ trend, rsi, pattern }) {

  let score = 50;

  if (trend === 'bullish') score += 20;
  if (trend === 'bearish') score += 10;

  if (rsi > 55 && rsi < 70) score += 15;

  if (pattern) score += 10;

  if (score > 100) score = 100;

  return {
    score,
    grade:
      score >= 85 ? 'A' :
      score >= 70 ? 'B' :
      score >= 55 ? 'C' : 'D'
  };
}
