/**
 * metrics.js
 * Pure functions implementing the three core formulas. Kept separate from data access so they're
 * unit-testable and reusable by both the API layer and the anomaly detector.
 */

function turnaroundSeconds(mr) {
  if (!mr.merged_at) return null;
  return (new Date(mr.merged_at) - new Date(mr.created_at)) / 1000;
}

function churnRatio(stats) {
  const total = stats.total ?? (stats.additions + stats.deletions);
  if (!total) return 0;
  const modified = stats.modified ?? Math.min(stats.additions, stats.deletions) * 2;
  return modified / total;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Median Absolute Deviation — robust spread measure, used instead of stddev for anomaly baselines
 *  because engineering metrics (turnaround, churn) are heavy-tailed and a few outliers would
 *  otherwise blow up a stddev-based threshold. */
function mad(values) {
  const m = median(values);
  if (m === null) return 0;
  const deviations = values.map(v => Math.abs(v - m));
  return median(deviations);
}

function deploymentsPerWeek(deployments, weekCount) {
  const successful = deployments.filter(d => d.status === 'success');
  return weekCount > 0 ? successful.length / weekCount : 0;
}

module.exports = { turnaroundSeconds, churnRatio, median, mean, mad, deploymentsPerWeek };
