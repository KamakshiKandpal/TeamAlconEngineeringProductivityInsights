/**
 * mockGitlab.js
 * Simulates GitLab API responses so the pipeline can be demoed without a live GitLab instance.
 * Swap this module for a real GitLab client (see gitlabClient.js pattern below) in production —
 * the rest of the pipeline (normalizer, metrics, anomalies) is agnostic to the source.
 */

const TEAMS = [
  { id: 1, name: 'payments', label: 'team::payments' },
  { id: 2, name: 'platform', label: 'team::platform' },
  { id: 3, name: 'growth', label: 'team::growth' },
];

const DEVELOPERS = [
  { id: 101, username: 'jsingh', name: 'Jyoti Singh', team_id: 1 },
  { id: 102, username: 'mrivera', name: 'Marco Rivera', team_id: 1 },
  { id: 103, username: 'lchen', name: 'Lily Chen', team_id: 2 },
  { id: 104, username: 'aokoye', name: 'Ada Okoye', team_id: 2 },
  { id: 105, username: 'ppatel', name: 'Priya Patel', team_id: 3 },
  { id: 106, username: 'dkim', name: 'David Kim', team_id: 3 },
];

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

/** Generate merge_requests?state=merged style payload for a date range. */
function generateMergeRequests({ fromDate, toDate, injectAnomalies = true }) {
  const mrs = [];
  let id = 100000;
  const days = Math.ceil((toDate - fromDate) / 86400000);

  for (let d = 0; d < days; d++) {
    const dayStart = new Date(fromDate.getTime() + d * 86400000);
    const mrsToday = randInt(2, 8);

    for (let i = 0; i < mrsToday; i++) {
      const dev = pick(DEVELOPERS);
      const createdAt = new Date(dayStart.getTime() + rand(0, 20) * 3600000);

      // Normal turnaround: 2-30 hours. Occasionally inject a slow PR anomaly.
      let turnaroundHours = rand(2, 30);
      const isSlowAnomaly = injectAnomalies && Math.random() < 0.04;
      if (isSlowAnomaly) turnaroundHours = rand(96, 240); // 4-10 days

      const mergedAt = new Date(createdAt.getTime() + turnaroundHours * 3600000);

      // Normal churn: additions dominate (net-new code). Occasionally inject high-churn anomaly
      // (lots of deletions relative to additions = rework/thrash).
      let additions = randInt(10, 300);
      let deletions = randInt(5, Math.floor(additions * 0.4));
      const isChurnAnomaly = injectAnomalies && Math.random() < 0.05;
      if (isChurnAnomaly) {
        additions = randInt(50, 150);
        deletions = randInt(120, 400); // heavy rework
      }
      const totalChanged = additions + deletions;
      const modifiedLines = Math.min(additions, deletions) * 2;

      mrs.push({
        id: id++,
        iid: id - 100000,
        project_id: dev.team_id * 10,
        title: `MR #${id} by ${dev.username}`,
        state: 'merged',
        created_at: createdAt.toISOString(),
        merged_at: mergedAt.toISOString(),
        closed_at: null,
        author: { id: dev.id, username: dev.username, name: dev.name },
        labels: [TEAMS.find(t => t.id === dev.team_id).label],
        changes_count: String(randInt(1, 12)),
        _stats: { additions, deletions, total: totalChanged, modified: modifiedLines },
        _flags: { isSlowAnomaly, isChurnAnomaly },
      });
    }
  }
  return mrs;
}

/** Generate deployments?environment=production style payload. */
function generateDeployments({ fromDate, toDate, injectAnomalies = true }) {
  const deployments = [];
  let id = 900000;
  const weeks = Math.ceil((toDate - fromDate) / (7 * 86400000));

  for (const team of TEAMS) {
    // Baseline: 8-15 deploys/week per team.
    for (let w = 0; w < weeks; w++) {
      const weekStart = new Date(fromDate.getTime() + w * 7 * 86400000);
      let deploysThisWeek = randInt(8, 15);

      // Inject a deployment drop anomaly on one team, one week (not the most recent, so it reads
      // clearly as "recovered" in the mock trend, or leave last week for a live/ongoing drop).
      const isDropAnomaly = injectAnomalies && team.id === 2 && w === weeks - 1;
      if (isDropAnomaly) deploysThisWeek = randInt(1, 3);

      for (let i = 0; i < deploysThisWeek; i++) {
        const createdAt = new Date(weekStart.getTime() + rand(0, 7) * 86400000);
        deployments.push({
          id: id++,
          iid: id - 900000,
          ref: 'main',
          sha: Math.random().toString(16).slice(2, 10),
          status: 'success',
          created_at: createdAt.toISOString(),
          finished_at: new Date(createdAt.getTime() + rand(2, 8) * 60000).toISOString(),
          environment: { id: team.id, name: 'production' },
          team_id: team.id,
          deployable: { user: { id: pick(DEVELOPERS.filter(d => d.team_id === team.id)).id } },
          _flags: { isDropAnomaly },
        });
      }
    }
  }
  return deployments;
}

module.exports = { TEAMS, DEVELOPERS, generateMergeRequests, generateDeployments };
