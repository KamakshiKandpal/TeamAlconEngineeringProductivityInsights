/**
 * githubNormalizer.js
 * Converts raw GitHub API payloads (from githubClient.js) into the exact row shape
 * services/mockGitlab.js already produces, so services/metrics.js, services/anomalies.js, and
 * every route in server.js work unchanged regardless of whether the data came from the mock
 * generator or a live GitHub repo.
 */

/** Matches the shape of generateMergeRequests() entries in services/mockGitlab.js. */
function normalizePullRequest(pr, stats, team) {
  const additions = stats.additions || 0;
  const deletions = stats.deletions || 0;
  const total = stats.total || additions + deletions;
  const modified = Math.min(additions, deletions) * 2;

  return {
    id: pr.id,
    iid: pr.number,
    project_id: team.id,
    title: pr.title,
    state: 'merged',
    created_at: pr.created_at,
    merged_at: pr.merged_at,
    closed_at: pr.closed_at,
    author: { id: pr.user.id, username: pr.user.login, name: pr.user.login },
    labels: [team.label],
    changes_count: String(pr.commits ?? 1),
    _stats: { additions, deletions, total, modified },
    _flags: {},
  };
}

/** Matches the shape of generateDeployments() entries in services/mockGitlab.js. */
function normalizeDeployment(deployment, team) {
  return {
    id: deployment.id,
    iid: deployment.id,
    ref: deployment.ref,
    sha: deployment.sha,
    status: 'success',
    created_at: deployment.created_at,
    finished_at: deployment.updated_at || deployment.created_at,
    environment: { id: team.id, name: deployment.environment || 'production' },
    team_id: team.id,
    deployable: { user: { id: deployment.creator?.id ?? null } },
    _flags: { isDerived: false },
  };
}

/**
 * Fallback used when a repo has no entries in the GitHub Deployments API (the common case for
 * repos without CI/CD wired up): treat every PR merged into the default branch as one deployment
 * event, dated by its merge time. Keeps "deployment frequency" meaningful from real activity
 * instead of silently showing zero.
 */
function deploymentFromMergedPR(pr, team) {
  return {
    id: 900000000 + pr.id,
    iid: pr.number,
    ref: pr.base?.ref || 'main',
    sha: pr.merge_commit_sha || null,
    status: 'success',
    created_at: pr.merged_at,
    finished_at: pr.merged_at,
    environment: { id: team.id, name: 'production (derived from merge)' },
    team_id: team.id,
    deployable: { user: { id: pr.user.id } },
    _flags: { isDerived: true },
  };
}

module.exports = { normalizePullRequest, normalizeDeployment, deploymentFromMergedPR };
