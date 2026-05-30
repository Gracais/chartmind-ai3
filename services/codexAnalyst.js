function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(/[,$]/g, ''));
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
  if (text.includes('BUY') || text.includes('LONG')) return 'bullish';
  if (text.includes('SELL') || text.includes('SHORT')) return 'bearish';
  return 'neutral';
}

function btcAlignment(direction, btcTrend) {
  const setupTone = directionTone(direction);
  const btcTone = String(btcTrend || 'unknown').toLowerCase();
  if (setupTone === 'neutral' || btcTone === 'unknown') return 'neutral';
  if (setupTone === btcTone) return 'aligned';
  return 'conflicting';
}

function computeRiskReward(setup) {
  const entry = toNumber(setup.entry);
  const stop = toNumber(setup.stopLoss);
  const target = toNumber(setup.takeProfit);
  if (entry === null || stop === null || target === null || entry === stop) return null;

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (!risk || !reward) return null;
  return Number((reward / risk).toFixed(2));
}

export function addCodexAnalyst(analysis = {}, { marketContext = null, ocrText = '' } = {}) {
  const setup = analysis.tradeSetup || {};
  const levelsVisible = (analysis.support?.length || 0) + (analysis.resistance?.length || 0);
  const riskReward = toNumber(setup.riskReward) ?? computeRiskReward(setup);
  const alignment = btcAlignment(setup.direction, marketContext?.trend);
  const warnings = [];
  let score = 52;

  if (levelsVisible >= 2) score += 12;
  if (hasValue(setup.entry) && hasValue(setup.stopLoss) && hasValue(setup.takeProfit)) score += 18;
  if (riskReward !== null && riskReward >= 1.5) score += 8;
  if (riskReward !== null && riskReward < 1.2) warnings.push('Reward-to-risk is thin; demand a cleaner entry or skip.');
  if (alignment === 'aligned') score += 8;
  if (alignment === 'conflicting') {
    score -= 12;
    warnings.push('Setup direction conflicts with the live BTC regime, so size and confirmation should be stricter.');
  }
  if (!hasValue(setup.stopLoss)) {
    score -= 14;
    warnings.push('No clear stop was produced; treat the setup as incomplete.');
  }
  if (!hasValue(setup.takeProfit)) {
    score -= 8;
    warnings.push('No clear target was produced; reward planning is incomplete.');
  }
  if (!ocrText) score -= 4;
  if (analysis.degraded) score = Math.min(score, 28);

  score = clamp(Math.round(score), 0, 100);

  const direction = String(setup.direction || 'NO TRADE').toUpperCase();
  const verdict = score >= 78
    ? 'Actionable with discipline'
    : score >= 58
      ? 'Tradable only after confirmation'
      : 'Stand aside or wait';

  const confluence = [
    `${levelsVisible || 'No'} visible support/resistance references were returned.`,
    riskReward !== null ? `Planned reward-to-risk checks at ${riskReward}:1.` : 'Reward-to-risk could not be verified from the setup.',
    alignment === 'aligned'
      ? 'BTC regime supports the proposed direction.'
      : alignment === 'conflicting'
        ? 'BTC regime is working against the proposed direction.'
        : 'BTC regime is neutral or unavailable.',
  ];

  return {
    ...analysis,
    codexAnalyst: {
      name: 'Codex',
      role: 'Risk auditor and second-opinion analyst',
      verdict,
      score,
      alignment,
      riskReward,
      direction,
      confluence,
      cautions: warnings,
      note: `Codex review: ${verdict}. ${warnings[0] || 'Plan quality is acceptable if the chart confirms entry, stop, and invalidation.'}`,
    },
  };
}
