/**
 * liveData.js
 * Loads real engineering data from GitHub for a set of repos and shapes it into exactly what
 * server.js already consumes from services/mockGitlab.js: { TEAMS, DEVELOPERS, MRS, ALL_DEPLOYS }.
 * One GitHub repo = one "team" (dashboard team filter), since GitHub has no first-class team
 * label the way GitLab groups do.
 *
 * Throws if GITHUB_TOKEN is unset or every configured repo fails to load — callers should catch
 * and fall back to services/mockGitlab.js so the dashboard never breaks.
 */
const github = require('./githubClient');
const { normalizePullRequest, normalizeDeployment, deploymentFromMergedPR } = require('./githubNormalizer');

function parseRepoSlug(slug, index) {
  const [owner, repo] = slug.split('/').map((s) => s.trim());
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOS entry "${slug}" — expected "owner/repo"`);
  return { owner, repo, id: index + 1, name: repo, label: `team::${repo}` };
}

async function loadRepoData(team, { fromDate, toDate }) {
  // Merged PRs are the "MRS" — mirrors mockGitlab's state==='merged' set.
  const rawPRs = await github.fetchPullRequests({ owner: team.owner, repo: team.repo, fromDate });
  const mergedInRange = rawPRs.filter((pr) => {
    if (!pr.merged_at) return false;
    const mergedAt = new Date(pr.merged_at);
    return mergedAt >= fromDate && mergedAt <= toDate;
  });

  const mrs = [];
  const authorsById = new Map();
  for (const pr of mergedInRange) {
    const stats = await github.fetchPRStats({ owner: team.owner, repo: team.repo, number: pr.number });
    mrs.push(normalizePullRequest(pr, stats, team));
    if (pr.user && !authorsById.has(pr.user.id)) authorsById.set(pr.user.id, pr.user);
  }

  // Deployments: prefer the real GitHub Deployments API; if the repo doesn't use it, derive one
  // deployment event per merged PR to the default branch (see githubNormalizer for rationale).
  let deploys = [];
  try {
    const rawDeployments = await github.fetchDeployments({ owner: team.owner, repo: team.repo, environment: 'production' });
    const inRange = rawDeployments.filter((d) => {
      const createdAt = new Date(d.created_at);
      return createdAt >= fromDate && createdAt <= toDate;
    });
    const withStatus = [];
    for (const d of inRange) {
      const state = await github.fetchDeploymentStatus({ owner: team.owner, repo: team.repo, deploymentId: d.id });
      if (state === 'success') withStatus.push(d);
    }
    deploys = withStatus.map((d) => normalizeDeployment(d, team));
  } catch (err) {
    console.warn(`[liveData] deployments API unavailable for ${team.owner}/${team.repo}: ${err.message}`);
  }

  if (deploys.length === 0 && mergedInRange.length > 0) {
    const repoInfo = await github.fetchRepo({ owner: team.owner, repo: team.repo }).catch(() => null);
    const defaultBranch = repoInfo?.default_branch || 'main';
    deploys = mergedInRange
      .filter((pr) => (pr.base?.ref || defaultBranch) === defaultBranch)
      .map((pr) => deploymentFromMergedPR(pr, team));
  }

  return { mrs, deploys, authorsById };
}

/**
 * @param {string[]} repos    ["owner/repo", ...]
 * @param {Date} fromDate
 * @param {Date} toDate
 */
async function loadGithubData({ repos, fromDate, toDate }) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set');
  }
  if (!repos || repos.length === 0) {
    throw new Error('No GitHub repos configured (set GITHUB_REPOS)');
  }

  const teams = repos.map(parseRepoSlug);
  const results = await Promise.allSettled(teams.map((team) => loadRepoData(team, { fromDate, toDate })));

  const MRS = [];
  const ALL_DEPLOYS = [];
  const authorsById = new Map();
  const authorTeamId = new Map();
  let anySucceeded = false;

  results.forEach((result, i) => {
    const team = teams[i];
    if (result.status === 'rejected') {
      console.error(`[liveData] failed to load ${team.owner}/${team.repo}: ${result.reason.message}`);
      return;
    }
    anySucceeded = true;
    MRS.push(...result.value.mrs);
    ALL_DEPLOYS.push(...result.value.deploys);
    for (const [id, user] of result.value.authorsById) {
      if (!authorsById.has(id)) {
        authorsById.set(id, user);
        authorTeamId.set(id, team.id);
      }
    }
  });

  if (!anySucceeded) {
    throw new Error('All configured GitHub repos failed to load');
  }

  // Resolve display names for the developer filter list (best-effort; falls back to the login).
  const DEVELOPERS = [];
  for (const [id, user] of authorsById) {
    const profile = await github.fetchUser({ login: user.login });
    DEVELOPERS.push({
      id,
      username: user.login,
      name: profile?.name || user.login,
      team_id: authorTeamId.get(id),
    });
  }

  const TEAMS = teams.map(({ id, name, label }) => ({ id, name, label }));

  return { TEAMS, DEVELOPERS, MRS, ALL_DEPLOYS };
}

module.exports = { loadGithubData };
