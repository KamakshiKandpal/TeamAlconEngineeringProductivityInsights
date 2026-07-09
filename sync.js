/**
 * sync.js
 * The scheduled sync worker described in ARCHITECTURE.md (section 1, path B: "Scheduled sync").
 * Run this on a cron (e.g. every 10-15 min) via your scheduler of choice (cron, GitHub Actions,
 * a k8s CronJob, BullMQ repeatable job, etc). It is idempotent — safe to re-run over an overlapping
 * window, since db.js upserts on the GitLab id.
 *
 * Usage:
 *   GITLAB_TOKEN=xxx GITLAB_BASE_URL=https://gitlab.example.com \
 *   GITLAB_PROJECT_IDS=123,456 DATABASE_URL=postgres://... \
 *   node sync.js --since=2026-06-01
 */
require('dotenv').config();

const gitlab = require('./services/gitlabClient');
const { normalizeMergeRequest, normalizeDeployment } = require('./services/normalizer');
const { detectSlowPRs, detectHighChurn, detectDeploymentDrops } = require('./services/anomalies');
const db = require('./db');

const PROJECT_IDS = (process.env.GITLAB_PROJECT_IDS || '').split(',').filter(Boolean);
const SYNC_WINDOW_HOURS = Number(process.env.SYNC_WINDOW_HOURS || 24); // reconciliation lookback

function parseSinceArg() {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  if (arg) return new Date(arg.split('=')[1]);
  return new Date(Date.now() - SYNC_WINDOW_HOURS * 3600000);
}

async function syncProject(projectId, fromDate, toDate, teamsByLabel) {
  console.log(`[sync] project ${projectId}: fetching MRs ${fromDate.toISOString()} -> ${toDate.toISOString()}`);

  const rawMRs = await gitlab.fetchMergeRequests({ projectId, fromDate, toDate });
  const normalizedMRs = [];

  for (const mr of rawMRs) {
    if (mr.state !== 'merged') continue; // only merged MRs count toward turnaround/churn
    const diffStats = await gitlab.fetchMRDiffStats({ projectId, mr });
    const normalized = normalizeMergeRequest(mr, diffStats, teamsByLabel);
    normalized.project_id = await db.upsertProject({
      gitlab_project_id: projectId, name: `project-${projectId}`, team_id: normalized.team_id,
    });
    if (normalized.author_id) {
      normalized.author_id = await db.upsertDeveloper({
        gitlab_user_id: mr.author.id, username: mr.author.username,
        display_name: mr.author.name, team_id: normalized.team_id,
      });
    }
    await db.upsertMergeRequest(normalized);
    normalizedMRs.push(normalized);
  }

  const rawDeployments = await gitlab.fetchDeployments({ projectId, fromDate, toDate });
  const normalizedDeploys = [];
  for (const dep of rawDeployments) {
    const normalized = normalizeDeployment(dep, teamsByLabel);
    normalized.project_id = await db.upsertProject({
      gitlab_project_id: projectId, name: `project-${projectId}`, team_id: normalized.team_id,
    });
    await db.upsertDeployment(normalized);
    normalizedDeploys.push(normalized);
  }

  console.log(`[sync] project ${projectId}: upserted ${normalizedMRs.length} MRs, ${normalizedDeploys.length} deployments`);
  return { mrs: normalizedMRs, deploys: normalizedDeploys };
}

async function runAnomalyDetection(allMRs, allDeploys) {
  const byTeam = {};
  for (const mr of allMRs) (byTeam[mr.team_id] ||= { mrs: [], deploys: [] }).mrs.push(mr);
  for (const d of allDeploys) (byTeam[d.team_id] ||= { mrs: [], deploys: [] }).deploys.push(d);

  let total = 0;
  for (const [teamId, { mrs, deploys }] of Object.entries(byTeam)) {
    if (teamId === 'null') continue;

    const slow = detectSlowPRs(
      mrs.map((m) => ({ ...m, merged_at: m.merged_at, created_at: m.created_at, author: { id: m.author_id }, id: m.gitlab_mr_id })),
      { teamId }
    );
    for (const a of slow) { await db.insertAnomaly(a); total++; }

    const churn = detectHighChurn(
      mrs.map((m) => ({ _stats: { additions: m.additions, deletions: m.deletions, total: m.total_changed_lines, modified: m.modified_lines }, author: { id: m.author_id } })),
      { teamId, groupBy: 'developer' }
    );
    for (const a of churn) { await db.insertAnomaly(a); total++; }
  }
  console.log(`[sync] anomaly detection: ${total} anomalies recorded`);
}

async function main() {
  const fromDate = parseSinceArg();
  const toDate = new Date();

  // In production, load this mapping from the `teams` table (seeded once from your GitLab groups).
  const teamsByLabel = {
    'team::payments': 1,
    'team::platform': 2,
    'team::growth': 3,
  };
  for (const [label, id] of Object.entries(teamsByLabel)) {
    await db.upsertTeam({ name: label.replace('team::', ''), gitlab_label: label });
  }

  let allMRs = [];
  let allDeploys = [];
  for (const projectId of PROJECT_IDS) {
    const { mrs, deploys } = await syncProject(projectId, fromDate, toDate, teamsByLabel);
    allMRs = allMRs.concat(mrs);
    allDeploys = allDeploys.concat(deploys);
  }

  await runAnomalyDetection(allMRs, allDeploys);
  await db.refreshRollups();
  console.log('[sync] done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[sync] fatal error:', err);
  process.exit(1);
});
