/**
 * anomalies.js
 * Implements the three anomaly detectors described in ARCHITECTURE.md, section 6.
 * Each function takes already-normalized rows (from the DB, or mock data shaped the same way)
 * and returns anomaly records ready to insert into the `anomalies` table / push over WebSocket.
 */
const { turnaroundSeconds, churnRatio, median, mad, deploymentsPerWeek } = require('./metrics');

const SLOW_PR_ABS_FLOOR_HOURS = 48;
const MIN_SAMPLE_FOR_CHURN = 5;
const DEPLOY_DROP_THRESHOLD = 0.5; // current week < 50% of trailing baseline

/** 1) Slow PR: individual MR turnaround far above the team's trailing baseline. */
function detectSlowPRs(mergeRequests, { teamId } = {}) {
  const turnaroundsHours = mergeRequests
    .map(mr => turnaroundSeconds(mr))
    .filter(v => v !== null)
    .map(s => s / 3600);

  const baseline = median(turnaroundsHours);
  const spread = mad(turnaroundsHours) || 1; // avoid divide-by-zero on tiny samples
  const threshold = Math.max(baseline + 2 * spread, SLOW_PR_ABS_FLOOR_HOURS);

  const anomalies = [];
  for (const mr of mergeRequests) {
    const hours = turnaroundSeconds(mr) / 3600;
    if (hours > threshold) {
      const madUnits = spread ? (hours - baseline) / spread : 0;
      anomalies.push({
        type: 'slow_pr',
        severity: madUnits > 4 ? 'high' : madUnits > 2.5 ? 'medium' : 'low',
        team_id: teamId,
        developer_id: mr.author?.id,
        entity_type: 'merge_request',
        entity_id: mr.id,
        metric_value: Number(hours.toFixed(1)),
        baseline_value: Number(baseline?.toFixed(1)),
        details: { title: mr.title, threshold_hours: Number(threshold.toFixed(1)) },
      });
    }
  }
  return anomalies;
}

/** 2) High code churn: a developer/team's rolling churn ratio is well above baseline. */
function detectHighChurn(mergeRequests, { teamId, groupBy = 'team' } = {}) {
  const ratios = mergeRequests.map(mr => churnRatio(mr._stats));
  if (ratios.length < MIN_SAMPLE_FOR_CHURN) return [];

  const baseline = median(ratios);
  const spread = mad(ratios) || 0.05;
  const threshold = baseline + 2 * spread;

  if (groupBy === 'team') {
    const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    if (avgRatio > threshold) {
      return [{
        type: 'high_churn',
        severity: avgRatio > threshold * 1.5 ? 'high' : 'medium',
        team_id: teamId,
        developer_id: null,
        entity_type: 'team_window',
        entity_id: teamId,
        metric_value: Number(avgRatio.toFixed(3)),
        baseline_value: Number(baseline.toFixed(3)),
        details: { sample_size: ratios.length, threshold: Number(threshold.toFixed(3)) },
      }];
    }
    return [];
  }

  // Per-developer grouping
  const byDev = {};
  for (const mr of mergeRequests) {
    const devId = mr.author?.id;
    (byDev[devId] ||= []).push(churnRatio(mr._stats));
  }
  const anomalies = [];
  for (const [devId, devRatios] of Object.entries(byDev)) {
    if (devRatios.length < MIN_SAMPLE_FOR_CHURN) continue;
    const avgRatio = devRatios.reduce((a, b) => a + b, 0) / devRatios.length;
    if (avgRatio > threshold) {
      anomalies.push({
        type: 'high_churn',
        severity: avgRatio > threshold * 1.5 ? 'high' : 'medium',
        team_id: teamId,
        developer_id: Number(devId),
        entity_type: 'developer_window',
        entity_id: Number(devId),
        metric_value: Number(avgRatio.toFixed(3)),
        baseline_value: Number(baseline.toFixed(3)),
        details: { sample_size: devRatios.length, threshold: Number(threshold.toFixed(3)) },
      });
    }
  }
  return anomalies;
}

/** 3) Deployment drop: this week's deploy count << trailing baseline for the team. */
function detectDeploymentDrops(weeklyDeployCounts, { teamId } = {}) {
  // weeklyDeployCounts: array of { week: Date, count: number }, ordered oldest -> newest
  if (weeklyDeployCounts.length < 3) return [];

  const current = weeklyDeployCounts[weeklyDeployCounts.length - 1];
  const priorWeeks = weeklyDeployCounts.slice(0, -1).map(w => w.count);
  const baseline = median(priorWeeks);

  if (baseline > 0 && current.count < baseline * DEPLOY_DROP_THRESHOLD) {
    const dropPct = Math.round((1 - current.count / baseline) * 100);
    return [{
      type: 'deployment_drop',
      severity: dropPct > 75 ? 'high' : dropPct > 50 ? 'medium' : 'low',
      team_id: teamId,
      developer_id: null,
      entity_type: 'deployment_window',
      entity_id: teamId,
      metric_value: current.count,
      baseline_value: baseline,
      window_start: current.week,
      details: { drop_pct: dropPct },
    }];
  }
  return [];
}

module.exports = { detectSlowPRs, detectHighChurn, detectDeploymentDrops };
