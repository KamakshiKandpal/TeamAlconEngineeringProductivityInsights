/**
 * normalizer.js
 * Converts raw GitLab API payloads (from gitlabClient.js) into the flat row shape that
 * services/metrics.js and services/anomalies.js already operate on. Keeping this as its own
 * module means metrics/anomaly code never needs to know about GitLab's payload shape, and the
 * mock generator and the real client can both feed the same downstream pipeline.
 */
const { churnRatio } = require('./metrics');

/** team_id is derived from a `team::<name>` label; falls back to null if the MR has none. */
function extractTeamId(labels, teamsByLabel) {
  const teamLabel = (labels || []).find((l) => l.startsWith('team::'));
  return teamLabel ? teamsByLabel[teamLabel] ?? null : null;
}

/**
 * @param mr           raw GitLab merge_request object
 * @param diffStats    { additions, deletions, total } from gitlabClient.fetchMRDiffStats
 * @param teamsByLabel { 'team::payments': 1, ... } lookup built from your teams table
 */
function normalizeMergeRequest(mr, diffStats, teamsByLabel = {}) {
  const additions = diffStats.additions || 0;
  const deletions = diffStats.deletions || 0;
  const total = diffStats.total || additions + deletions;
  const modified = Math.min(additions, deletions) * 2;

  return {
    gitlab_mr_id: mr.id,
    project_id: mr.project_id,
    author_id: mr.author?.id ?? null,
    team_id: extractTeamId(mr.labels, teamsByLabel),
    title: mr.title,
    created_at: new Date(mr.created_at),
    merged_at: mr.merged_at ? new Date(mr.merged_at) : null,
    closed_at: mr.closed_at ? new Date(mr.closed_at) : null,
    state: mr.state,
    additions,
    deletions,
    modified_lines: modified,
    total_changed_lines: total,
    churn_ratio: churnRatio({ additions, deletions, total, modified }),
    turnaround_hrs: mr.merged_at
      ? (new Date(mr.merged_at) - new Date(mr.created_at)) / 3600000
      : null,
    raw_payload: mr,
  };
}

function normalizeDeployment(deployment, teamsByLabel = {}) {
  return {
    gitlab_deployment_id: deployment.id,
    project_id: deployment.project_id,
    team_id: deployment.team_id ?? null, // set by caller if resolved via project->team mapping
    environment: deployment.environment?.name,
    status: deployment.status,
    triggered_by_id: deployment.deployable?.user?.id ?? null,
    created_at: new Date(deployment.created_at),
    finished_at: deployment.finished_at ? new Date(deployment.finished_at) : null,
    sha: deployment.sha,
    raw_payload: deployment,
  };
}

module.exports = { normalizeMergeRequest, normalizeDeployment, extractTeamId };
