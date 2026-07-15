/**
 * githubClient.js
 * Thin wrapper around the real GitHub REST API v3. This is the "actual data" source for the
 * dashboard, mirroring the shape of services/gitlabClient.js so both providers can feed the
 * same normalizer/metrics pipeline.
 *
 * Required env var:
 *   GITHUB_TOKEN   a personal access token (classic, no scopes needed for public repos; or a
 *                   fine-grained token with Pull requests / Contents / Deployments read access
 *                   for private repos). Without it, requests still work for public repos but are
 *                   capped at GitHub's unauthenticated rate limit (60/hour).
 *
 * This module only READS data (pull requests, PR diff stats, deployments). It never writes to
 * GitHub.
 */
const API_BASE = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;

const MAX_RETRIES = 5;
const PER_PAGE = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return headers;
}

/** Parses the `Link` header GitHub uses for pagination (same format as GitLab). */
function parseNextPage(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(',').find((part) => part.includes('rel="next"'));
  if (!match) return null;
  const urlMatch = match.match(/<([^>]+)>/);
  return urlMatch ? urlMatch[1] : null;
}

/**
 * Low-level fetch wrapper: handles auth, retries on rate limits (403 secondary limit / 429) and
 * 5xx with exponential backoff, and respects GitHub's rate-limit headers.
 */
async function githubFetch(path, { params = {}, attempt = 1 } = {}) {
  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  const res = await fetch(url, { headers: authHeaders() });

  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  if (!Number.isNaN(remaining) && remaining < 3 && res.status !== 403) {
    const resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const waitMs = Math.max(0, resetAt - Date.now());
    if (waitMs > 0) {
      console.warn(`[githubClient] rate limit nearly exhausted (${remaining} left), pausing ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }

  if (res.status === 403 || res.status === 429 || res.status >= 500) {
    if (attempt > MAX_RETRIES) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API failed after ${MAX_RETRIES} retries: ${res.status} ${url} ${body}`);
    }
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    console.warn(`[githubClient] ${res.status} on ${url.pathname}, retrying in ${retryAfter}s (attempt ${attempt})`);
    await sleep(retryAfter * 1000);
    return githubFetch(path, { params, attempt: attempt + 1 });
  }

  if (res.status === 404) {
    throw new Error(`GitHub API 404 on ${url.pathname} — repo not found or not accessible with the configured token`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API error ${res.status} on ${url.pathname}: ${body}`);
  }

  const linkHeader = res.headers.get('link');
  const data = await res.json();
  return { data, nextPage: parseNextPage(linkHeader) };
}

/** Fetches every page for a paginated endpoint, following `Link: rel="next"`. */
async function fetchAllPages(path, params = {}, { stopWhen } = {}) {
  let results = [];
  let nextUrl = null;
  let firstCall = true;

  do {
    const { data, nextPage } = firstCall
      ? await githubFetch(path, { params: { per_page: PER_PAGE, ...params } })
      : await githubFetch(nextUrl);
    results = results.concat(data);
    nextUrl = nextPage;
    firstCall = false;
    if (stopWhen && data.some(stopWhen)) break;
  } while (nextUrl);

  return results;
}

/** GET /repos/:owner/:repo — basic repo metadata (default branch, etc). */
async function fetchRepo({ owner, repo }) {
  const { data } = await githubFetch(`/repos/${owner}/${repo}`);
  return data;
}

/**
 * Fetch closed pull requests, newest-updated first, stopping once results fall outside the
 * requested window (the list endpoint has no native date filter, but sorting by `updated` desc
 * lets us bail out early instead of paging the whole history).
 */
async function fetchPullRequests({ owner, repo, fromDate }) {
  return fetchAllPages(
    `/repos/${owner}/${repo}/pulls`,
    { state: 'closed', sort: 'updated', direction: 'desc' },
    { stopWhen: (pr) => new Date(pr.updated_at) < fromDate }
  );
}

/**
 * Fetch line-change stats for a single PR.
 * GET /repos/:owner/:repo/pulls/:number -> { additions, deletions, changed_files, commits }
 * (the list endpoint above doesn't include these fields — GitHub requires the single-PR fetch.)
 */
async function fetchPRStats({ owner, repo, number }) {
  try {
    const { data } = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`);
    return {
      additions: data.additions || 0,
      deletions: data.deletions || 0,
      total: (data.additions || 0) + (data.deletions || 0),
    };
  } catch (err) {
    console.warn(`[githubClient] could not fetch diff stats for PR #${number}: ${err.message}`);
    return { additions: 0, deletions: 0, total: 0 };
  }
}

/** GET /repos/:owner/:repo/deployments?environment=... */
async function fetchDeployments({ owner, repo, environment } = {}) {
  return fetchAllPages(`/repos/${owner}/${repo}/deployments`, environment ? { environment } : {});
}

/** GET /repos/:owner/:repo/deployments/:id/statuses — most recent status first. */
async function fetchDeploymentStatus({ owner, repo, deploymentId }) {
  try {
    const { data } = await githubFetch(`/repos/${owner}/${repo}/deployments/${deploymentId}/statuses`, {
      params: { per_page: 1 },
    });
    return data[0]?.state || null;
  } catch (err) {
    console.warn(`[githubClient] could not fetch status for deployment ${deploymentId}: ${err.message}`);
    return null;
  }
}

/** GET /users/:login — used to resolve a display name for the developer filter list. */
async function fetchUser({ login }) {
  try {
    const { data } = await githubFetch(`/users/${login}`);
    return data;
  } catch (err) {
    return null;
  }
}

module.exports = {
  fetchRepo,
  fetchPullRequests,
  fetchPRStats,
  fetchDeployments,
  fetchDeploymentStatus,
  fetchUser,
};
