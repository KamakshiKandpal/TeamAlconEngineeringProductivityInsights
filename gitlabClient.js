/**
 * gitlabClient.js
 * Thin wrapper around the real GitLab REST API v4. Replaces services/mockGitlab.js in production.
 *
 * Required env vars:
 *   GITLAB_BASE_URL   e.g. https://gitlab.com  (or your self-managed instance)
 *   GITLAB_TOKEN      a personal/project/group access token with `read_api` scope
 *
 * This module only READS data (merge requests, commit stats, deployments, group members/labels).
 * It never writes to GitLab.
 */
const BASE_URL = process.env.GITLAB_BASE_URL || 'https://gitlab.com';
const TOKEN = process.env.GITLAB_TOKEN;

if (!TOKEN) {
  console.warn('[gitlabClient] GITLAB_TOKEN is not set — API calls will fail with 401.');
}

const MAX_RETRIES = 5;
const PER_PAGE = 100;

/** Sleep helper for backoff. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Low-level fetch wrapper: handles auth header, retries on 429/5xx with exponential backoff,
 * and respects GitLab's rate-limit headers instead of hammering the API blindly.
 */
async function gitlabFetch(path, { params = {}, attempt = 1 } = {}) {
  const url = new URL(path.startsWith('http') ? path : `${BASE_URL}/api/v4${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': TOKEN },
  });

  // Respect rate limiting: GitLab returns RateLimit-Remaining / Retry-After.
  const remaining = Number(res.headers.get('ratelimit-remaining'));
  if (!Number.isNaN(remaining) && remaining < 5) {
    const resetIn = Number(res.headers.get('ratelimit-reset') || 5);
    console.warn(`[gitlabClient] rate limit nearly exhausted (${remaining} left), pausing ${resetIn}s`);
    await sleep(resetIn * 1000);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`GitLab API failed after ${MAX_RETRIES} retries: ${res.status} ${url}`);
    }
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    console.warn(`[gitlabClient] ${res.status} on ${url.pathname}, retrying in ${retryAfter}s (attempt ${attempt})`);
    await sleep(retryAfter * 1000);
    return gitlabFetch(path, { params, attempt: attempt + 1 });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitLab API error ${res.status} on ${url.pathname}: ${body}`);
  }

  const linkHeader = res.headers.get('link');
  const data = await res.json();
  return { data, nextPage: parseNextPage(linkHeader) };
}

/** Parses the `Link` header GitLab uses for keyset/offset pagination. */
function parseNextPage(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(',').find((part) => part.includes('rel="next"'));
  if (!match) return null;
  const urlMatch = match.match(/<([^>]+)>/);
  return urlMatch ? urlMatch[1] : null;
}

/** Fetches every page for a paginated endpoint, following `Link: rel="next"`. */
async function fetchAllPages(path, params = {}) {
  let results = [];
  let nextUrl = null;
  let firstCall = true;

  do {
    const { data, nextPage } = firstCall
      ? await gitlabFetch(path, { params: { per_page: PER_PAGE, ...params } })
      : await gitlabFetch(nextUrl);
    results = results.concat(data);
    nextUrl = nextPage;
    firstCall = false;
  } while (nextUrl);

  return results;
}

// ---------------------------------------------------------------------------
// Public API — mirrors the shape of services/mockGitlab.js so it's a drop-in swap
// ---------------------------------------------------------------------------

/**
 * Fetch merged MRs for a project within a date range.
 * GET /projects/:id/merge_requests?state=merged&updated_after=&updated_before=
 */
async function fetchMergeRequests({ projectId, fromDate, toDate, state = 'merged' }) {
  return fetchAllPages(`/projects/${encodeURIComponent(projectId)}/merge_requests`, {
    state,
    updated_after: fromDate.toISOString(),
    updated_before: toDate.toISOString(),
    order_by: 'updated_at',
    sort: 'asc',
  });
}

/**
 * Fetch line-change stats for a merged MR via its merge commit.
 * GET /projects/:id/repository/commits/:sha  -> { stats: { additions, deletions, total } }
 * Falls back gracefully if a merge_commit_sha is missing (e.g. fast-forward merges).
 */
async function fetchMRDiffStats({ projectId, mr }) {
  const sha = mr.merge_commit_sha || mr.sha;
  if (!sha) return { additions: 0, deletions: 0, total: 0 };
  try {
    const { data } = await gitlabFetch(
      `/projects/${encodeURIComponent(projectId)}/repository/commits/${sha}`
    );
    return data.stats || { additions: 0, deletions: 0, total: 0 };
  } catch (err) {
    console.warn(`[gitlabClient] could not fetch diff stats for MR !${mr.iid}: ${err.message}`);
    return { additions: 0, deletions: 0, total: 0 };
  }
}

/**
 * Fetch production deployments for a project within a date range.
 * GET /projects/:id/deployments?environment=production&status=success
 */
async function fetchDeployments({ projectId, fromDate, toDate, environment = 'production' }) {
  return fetchAllPages(`/projects/${encodeURIComponent(projectId)}/deployments`, {
    environment,
    status: 'success',
    updated_after: fromDate.toISOString(),
    updated_before: toDate.toISOString(),
    order_by: 'created_at',
    sort: 'asc',
  });
}

/** GET /groups/:id/members -- used to build the developer/team dimension tables. */
async function fetchGroupMembers({ groupId }) {
  return fetchAllPages(`/groups/${encodeURIComponent(groupId)}/members`);
}

/** GET /projects/:id/labels -- used to discover team::<name> labels for the team dimension. */
async function fetchProjectLabels({ projectId }) {
  return fetchAllPages(`/projects/${encodeURIComponent(projectId)}/labels`);
}

module.exports = {
  fetchMergeRequests,
  fetchMRDiffStats,
  fetchDeployments,
  fetchGroupMembers,
  fetchProjectLabels,
};
