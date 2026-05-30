function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(/[,$%]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '' && value !== 'Not visible';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function directionTone(direction) {
  const text = String(direction || '').toUpperCase();
  if (text.includes('BUY')  || text.includes('LONG'))  return 'bullish';
  if (text.includes('SELL') || text.includes('SHORT')) return 'bearish';
  return 'neutral';
}

function btcAlignment(direction, btcTrend) {
  const setupTone = directionTone(direction);
  const btcTone   = String(btcTrend || 'unknown').toLowerCase();
  if (setupTone === 'neutral' || btcTone === 'unknown') return 'neutral';
  if (setupTone === btcTone) return 'aligned';
  return 'conflicting';
}

function computeRiskReward(setup) {
  const entry  = toNumber(setup.entry);
  const stop   = toNumber(setup.stopLoss);
  const target = toNumber(setup.takeProfit1 ?? setup.takeProfit);
  if (entry === null || stop === null || target === null || entry === stop) return null;
  const risk   = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (!risk || !reward) return null;
  return Number((reward / risk).toFixed(2));
}

export function addCodexAnalyst(analysis = {}, { marketContext = null, ocrText = '' } = {}) {
  const setup    = analysis.tradeSetup         || {};
  const ms       = analysis.marketStructureDetail || {};
  const prob     = analysis.probability        || {};
  const warnings = [];
  let score      = 50;

  // ── Market Structure (25 pts) ─────────────────────────────────────────────
  if (hasValue(ms.bos)   && ms.bos   !== 'Not visible') score += 8;
  if (hasValue(ms.choch) && ms.choch !== 'Not visible') score += 5;
  if (ms.orderBlocks?.length)    score += 6;
  if (ms.fairValueGaps?.length)  score += 3;
  if (ms.liquidityZones?.length) score += 3;

  // ── S/R levels (10 pts) ──────────────────────────────────────────────────
  const levelsVisible = (analysis.support?.length || 0) + (analysis.resistance?.length || 0);
  if (levelsVisible >= 3) score += 10;
  else if (levelsVisible >= 1) score += 5;

  // ── Trade Setup quality (20 pts) ─────────────────────────────────────────
  const riskReward = toNumber(setup.riskReward) ?? computeRiskReward(setup);
  if (hasValue(setup.entry) && hasValue(setup.stopLoss) && hasValue(setup.takeProfit1)) score += 10;
  if (riskReward !== null && riskReward >= 2.0) score += 10;
  else if (riskReward !== null && riskReward >= 1.5) score += 6;
  else if (riskReward !== null && riskReward < 1.2) {
    score -= 8;
    warnings.push('R:R below 1.2 — reward does not justify risk. Skip or wait for better entry.');
  }

  // ── Multi TP bonus ────────────────────────────────────────────────────────
  if (hasValue(setup.takeProfit2)) score += 3;
  if (hasValue(setup.takeProfit3)) score += 2;

  // ── Momentum confluence (10 pts) ─────────────────────────────────────────
  const rsi = toNumber(analysis.rsi);
  if (rsi !== null) {
    const dir = directionTone(setup.direction);
    if (dir === 'bullish' && rsi > 40 && rsi < 70) score += 5;
    else if (dir === 'bearish' && rsi > 30 && rsi < 60) score += 5;
    else if ((dir === 'bullish' && rsi >= 70) || (dir === 'bearish' && rsi <= 30)) {
      score -= 5;
      warnings.push(`RSI at ${rsi} — entering against momentum extreme. Higher failure risk.`);
    }
  }
  if (hasValue(analysis.macd) && analysis.macd !== 'Not visible') score += 5;

  // ── Volume (8 pts) ────────────────────────────────────────────────────────
  if (hasValue(analysis.volumeAnalysis) && analysis.volumeAnalysis !== 'Not visible') score += 5;
  if (hasValue(analysis.volumeDivergence) && analysis.volumeDivergence !== 'Not visible') {
    if (analysis.volumeDivergence.toLowerCase().includes('declining') ||
        analysis.volumeDivergence.toLowerCase().includes('divergence')) {
      score -= 5;
      warnings.push('Volume divergence detected — price move may not be sustained.');
    } else {
      score += 3;
    }
  }

  // ── Candle pattern (5 pts) ────────────────────────────────────────────────
  if (hasValue(analysis.candlePattern) && analysis.candlePattern !== 'Not visible') score += 5;

  // ── BTC alignment (15 pts) ───────────────────────────────────────────────
  const alignment = btcAlignment(setup.direction, marketContext?.trend);
  if (alignment === 'aligned') {
    score += 15;
  } else if (alignment === 'conflicting') {
    score -= 15;
    warnings.push('Setup conflicts with live BTC regime. Size down and require stronger confirmation before entry.');
  }

  // ── Futures context (5 pts) ───────────────────────────────────────────────
  if (hasValue(analysis.openInterest) && analysis.openInterest !== 'Not visible') score += 3;
  if (hasValue(analysis.fundingRate)  && analysis.fundingRate  !== 'Not visible') score += 2;

  // ── Penalties ─────────────────────────────────────────────────────────────
  if (!hasValue(setup.stopLoss)) {
    score -= 15;
    warnings.push('No stop loss identified — setup is incomplete and unacceptable for risk management.');
  }
  if (!hasValue(setup.takeProfit1)) {
    score -= 8;
    warnings.push('No take profit identified — reward target is undefined.');
  }
  if (!ocrText) score -= 3;
  if (analysis.degraded) score = Math.min(score, 28);

  // ── Probability boost/penalty ─────────────────────────────────────────────
  const dirTone   = directionTone(setup.direction);
  const probScore = dirTone === 'bullish' ? toNumber(prob.bullish) :
                    dirTone === 'bearish' ? toNumber(prob.bearish) : null;
  if (probScore !== null) {
    if (probScore >= 65) score += 5;
    else if (probScore < 45) {
      score -= 5;
      warnings.push(`AI probability for this direction is only ${probScore}% — low conviction setup.`);
    }
  }

  score = clamp(Math.round(score), 0, 100);

  const direction = String(setup.direction || 'NO TRADE').toUpperCase();
  const verdict   = score >= 80
    ? '✅ High conviction — actionable with discipline'
    : score >= 65
      ? '⚠️ Moderate conviction — wait for confirmation'
      : score >= 50
        ? '🟡 Low conviction — paper trade or skip'
        : '🔴 Stand aside — risk outweighs opportunity';

  const confluence = [
    `${levelsVisible || 'No'} S/R levels visible.`,
    riskReward !== null ? `R:R at ${riskReward}:1.` : 'R:R could not be verified.',
    ms.orderBlocks?.length ? `${ms.orderBlocks.length} Order Block(s) identified.` : 'No OBs detected.',
    ms.fairValueGaps?.length ? `${ms.fairValueGaps.length} FVG(s) identified.` : 'No FVGs detected.',
    alignment === 'aligned'     ? '✅ BTC regime supports direction.' :
    alignment === 'conflicting' ? '❌ BTC regime conflicts with direction.' :
                                  '⚪ BTC regime neutral.',
    probScore !== null ? `AI probability: ${probScore}% for this direction.` : '',
  ].filter(Boolean);

  return {
    ...analysis,
    codexAnalyst: {
      name:       'Codex',
      role:       'Risk auditor & second-opinion analyst',
      verdict,
      score,
      alignment,
      riskReward,
      direction,
      confluence,
      cautions:   warnings,
      note:       `Codex Score ${score}/100 — ${verdict}. ${warnings[0] || 'Setup structure is acceptable. Confirm at entry level before executing.'}`,
    },
  };
}
