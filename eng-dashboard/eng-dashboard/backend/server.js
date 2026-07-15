/**
 * server.js
 * Reference implementation of the Metrics/Query API described in ARCHITECTURE.md.
 * At boot, loads real data from GitHub (see services/liveData.js) when GITHUB_TOKEN is set;
 * otherwise — or if the live load fails — falls back to the in-memory mock generator
 * (services/mockGitlab.js) so the dashboard always runs standalone with `npm install && npm start`.
 * Swap `db.js` calls for real Postgres queries against the schema in db/schema.sql for a
 * durable/production data layer — the route handlers stay the same shape either way.
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const mockGitlab = require('./services/mockGitlab');
const { loadGithubData } = require('./services/liveData');
const { turnaroundSeconds, churnRatio, mean, median, deploymentsPerWeek } = require('./services/metrics');
const { detectSlowPRs, detectHighChurn, detectDeploymentDrops } = require('./services/anomalies');
const { buildInsightSummary } = require('./services/insights');

const app = express();
app.use(cors());
app.use(express.json());

// ---- In-memory "warehouse" seeded once at boot (stand-in for Postgres rollups) ----
const RANGE_DAYS = 90;
const now = new Date();
const rangeStart = new Date(now.getTime() - RANGE_DAYS * 86400000);
const GITHUB_SYNC_INTERVAL_MINUTES = Number(process.env.GITHUB_SYNC_INTERVAL_MINUTES || 10);

let TEAMS, DEVELOPERS, ALL_MRS, ALL_DEPLOYS, MRS;
let dataSource = null; // 'github-live' | 'mock-data', set by bootstrap()

function withTeamId(mr) {
  const label = mr.labels[0];
  const team = TEAMS.find(t => t.label === label);
  return { ...mr, team_id: team?.id };
}

function loadMockData() {
  TEAMS = mockGitlab.TEAMS;
  DEVELOPERS = mockGitlab.DEVELOPERS;
  ALL_MRS = mockGitlab.generateMergeRequests({ fromDate: rangeStart, toDate: now });
  ALL_DEPLOYS = mockGitlab.generateDeployments({ fromDate: rangeStart, toDate: now });
  MRS = ALL_MRS.map(withTeamId);
}

function getConfiguredRepos() {
  return (process.env.GITHUB_REPOS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Loads live GitHub data into the module-level arrays; throws on total failure. */
async function loadLiveData() {
  const repos = getConfiguredRepos();
  const live = await loadGithubData({ repos, fromDate: rangeStart, toDate: now });
  TEAMS = live.TEAMS;
  DEVELOPERS = live.DEVELOPERS;
  ALL_MRS = live.MRS;
  ALL_DEPLOYS = live.ALL_DEPLOYS;
  MRS = ALL_MRS.map(withTeamId);
}

/** Boot sequence: try live GitHub data first, fall back to mock on any failure. */
async function bootstrap() {
  if (process.env.GITHUB_TOKEN) {
    try {
      await loadLiveData();
      dataSource = 'github-live';
      console.log(
        `[server] loaded live GitHub data: ${ALL_MRS.length} merged PRs, ${ALL_DEPLOYS.length} deployments ` +
        `across ${getConfiguredRepos().length} repo(s)`
      );
    } catch (err) {
      console.error('[server] GitHub live data load failed, falling back to mock data:', err.message);
    }
  }
  if (!dataSource) {
    loadMockData();
    dataSource = 'mock-data';
    console.log('[server] GITHUB_TOKEN not set (or live load failed) — using mock data.');
  }
}

/** Periodic refresh while running live — keeps the dashboard current without a restart. */
function scheduleLiveRefresh() {
  if (dataSource !== 'github-live') return;
  setInterval(async () => {
    try {
      await loadLiveData();
      console.log(`[server] refreshed live GitHub data: ${ALL_MRS.length} merged PRs, ${ALL_DEPLOYS.length} deployments`);
    } catch (err) {
      // Keep serving the last good snapshot rather than flipping to mock mid-run.
      console.error('[server] live data refresh failed, keeping previous snapshot:', err.message);
    }
  }, GITHUB_SYNC_INTERVAL_MINUTES * 60000);
}

// ---- Filtering helper shared by every endpoint ----
function applyFilters(rows, { team, developer, from, to }, dateField = 'created_at') {
  return rows.filter(r => {
    if (team && String(r.team_id) !== String(team)) return false;
    if (developer && String(r.author?.id ?? r.deployable?.user?.id) !== String(developer)) return false;
    const d = new Date(r[dateField]);
    if (from && d < new Date(from)) return false;
    if (to && d > new Date(to)) return false;
    return true;
  });
}

function weekBucket(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day; // start of week (Sun)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff)).toISOString().slice(0, 10);
}
function dayBucket(date) { return new Date(date).toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// GET /api/v1/filters/teams
// ---------------------------------------------------------------------------
app.get('/api/v1/filters/teams', (req, res) => {
  res.json(TEAMS.map(({ id, name }) => ({ id, name })));
});

app.get('/api/v1/health', async (req, res) => {
  res.json({
    ok: true,
    dataSource,
    insightsSource: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY ? 'anthropic-configured' : 'mock-data',
    timestamp: new Date().toISOString(),
  });
});

// GET /api/v1/filters/developers?team=
app.get('/api/v1/filters/developers', (req, res) => {
  const { team } = req.query;
  const devs = DEVELOPERS.filter(d => !team || String(d.team_id) === String(team));
  res.json(devs.map(({ id, username, name }) => ({ id, username, name })));
});

// ---------------------------------------------------------------------------
// GET /api/v1/kpis
// ---------------------------------------------------------------------------
app.get('/api/v1/kpis', (req, res) => {
  const mrs = applyFilters(MRS.filter(m => m.state === 'merged'), req.query, 'merged_at');
  const deploys = applyFilters(ALL_DEPLOYS, req.query);

  const turnaroundsHrs = mrs.map(m => turnaroundSeconds(m) / 3600);
  const churnRatios = mrs.map(m => churnRatio(m._stats));

  const from = req.query.from ? new Date(req.query.from) : rangeStart;
  const to = req.query.to ? new Date(req.query.to) : now;
  const weeks = Math.max(1, (to - from) / (7 * 86400000));

  res.json({
    pr_turnaround: {
      avg_hours: Number(mean(turnaroundsHrs)?.toFixed(1) ?? 0),
      median_hours: Number(median(turnaroundsHrs)?.toFixed(1) ?? 0),
      sample_size: mrs.length,
    },
    code_churn: {
      avg_ratio: Number(mean(churnRatios)?.toFixed(3) ?? 0),
      sample_size: mrs.length,
    },
    deployment_frequency: {
      per_week: Number(deploymentsPerWeek(deploys, weeks).toFixed(1)),
      total: deploys.filter(d => d.status === 'success').length,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/trends/pr-turnaround
// ---------------------------------------------------------------------------
app.get('/api/v1/trends/pr-turnaround', (req, res) => {
  const granularity = req.query.granularity === 'week' ? weekBucket : dayBucket;
  const mrs = applyFilters(MRS.filter(m => m.state === 'merged'), req.query, 'merged_at');

  const buckets = {};
  for (const mr of mrs) {
    const key = granularity(mr.merged_at);
    (buckets[key] ||= []).push(turnaroundSeconds(mr) / 3600);
  }
  const series = Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({
      date,
      avg_hours: Number(mean(values).toFixed(1)),
      median_hours: Number(median(values).toFixed(1)),
      count: values.length,
    }));
  res.json(series);
});

// ---------------------------------------------------------------------------
// GET /api/v1/trends/code-churn
// ---------------------------------------------------------------------------
app.get('/api/v1/trends/code-churn', (req, res) => {
  const granularity = req.query.granularity === 'week' ? weekBucket : dayBucket;
  const mrs = applyFilters(MRS.filter(m => m.state === 'merged'), req.query, 'merged_at');

  const buckets = {};
  for (const mr of mrs) {
    const key = granularity(mr.merged_at);
    (buckets[key] ||= []).push(churnRatio(mr._stats));
  }
  const series = Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({
      date,
      avg_ratio: Number(mean(values).toFixed(3)),
      count: values.length,
    }));
  res.json(series);
});

// ---------------------------------------------------------------------------
// GET /api/v1/trends/deployment-frequency
// ---------------------------------------------------------------------------
app.get('/api/v1/trends/deployment-frequency', (req, res) => {
  const deploys = applyFilters(ALL_DEPLOYS.filter(d => d.status === 'success'), req.query);
  const buckets = {};
  for (const d of deploys) {
    const key = weekBucket(d.created_at);
    buckets[key] = (buckets[key] || 0) + 1;
  }
  const series = Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, count]) => ({ week, deployments: count }));
  res.json(series);
});

// ---------------------------------------------------------------------------
// GET /api/v1/anomalies
// ---------------------------------------------------------------------------
app.get('/api/v1/anomalies', (req, res) => {
  const { type, team } = req.query;
  const results = [];

  const teamsToScan = team ? TEAMS.filter(t => String(t.id) === String(team)) : TEAMS;

  for (const t of teamsToScan) {
    const teamMrs = MRS.filter(m => m.state === 'merged' && m.team_id === t.id);
    const teamDeploys = ALL_DEPLOYS.filter(d => d.team_id === t.id && d.status === 'success');

    if (!type || type === 'slow_pr') {
      results.push(...detectSlowPRs(teamMrs, { teamId: t.id }));
    }
    if (!type || type === 'high_churn') {
      results.push(...detectHighChurn(teamMrs, { teamId: t.id, groupBy: 'developer' }));
    }
    if (!type || type === 'deployment_drop') {
      const weekly = {};
      for (const d of teamDeploys) {
        const wk = weekBucket(d.created_at);
        weekly[wk] = (weekly[wk] || 0) + 1;
      }
      const weeklyArr = Object.entries(weekly)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, count]) => ({ week, count }));
      results.push(...detectDeploymentDrops(weeklyArr, { teamId: t.id }));
    }
  }

  res.json(results.map((a, i) => ({ id: i + 1, detected_at: new Date().toISOString(), acknowledged: false, ...a })));
});

app.get('/api/v1/insights', async (req, res) => {
  try {
    const mrs = applyFilters(MRS.filter(m => m.state === 'merged'), req.query, 'merged_at');
    const deploys = applyFilters(ALL_DEPLOYS, req.query);
    const turnaroundsHrs = mrs.map(m => turnaroundSeconds(m) / 3600);
    const churnRatios = mrs.map(m => churnRatio(m._stats));

    const from = req.query.from ? new Date(req.query.from) : rangeStart;
    const to = req.query.to ? new Date(req.query.to) : now;
    const weeks = Math.max(1, (to - from) / (7 * 86400000));

    const payload = {
      kpis: {
        pr_turnaround: {
          avg_hours: Number(mean(turnaroundsHrs)?.toFixed(1) ?? 0),
          median_hours: Number(median(turnaroundsHrs)?.toFixed(1) ?? 0),
          sample_size: mrs.length,
        },
        code_churn: {
          avg_ratio: Number(mean(churnRatios)?.toFixed(3) ?? 0),
          sample_size: mrs.length,
        },
        deployment_frequency: {
          per_week: Number(deploymentsPerWeek(deploys, weeks).toFixed(1)),
          total: deploys.filter(d => d.status === 'success').length,
        },
      },
      anomalies: [],
    };

    const anomalies = [];
    anomalies.push(...detectSlowPRs(mrs, { teamId: req.query.team || null }));
    anomalies.push(...detectHighChurn(mrs, { teamId: req.query.team || null, groupBy: 'developer' }));
    const weekly = {};
    for (const d of deploys) {
      const wk = weekBucket(d.created_at);
      weekly[wk] = (weekly[wk] || 0) + 1;
    }
    const weeklyArr = Object.entries(weekly).sort(([a], [b]) => a.localeCompare(b)).map(([week, count]) => ({ week, count }));
    anomalies.push(...detectDeploymentDrops(weeklyArr, { teamId: req.query.team || null }));
    payload.anomalies = anomalies;

    const insight = await buildInsightSummary(payload, { apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
    res.json(insight);
  } catch (error) {
    console.error('[insights] failed', error);
    res.status(500).json({ summary: 'Unable to produce insight summary right now.', source: 'fallback', generatedAt: new Date().toISOString() });
  }
});

// ---------------------------------------------------------------------------
// WebSocket: pushes a simulated new anomaly every 45s so the UI can demo real-time behavior
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/anomalies' });

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected', message: 'Live anomaly feed connected' }));
});

setInterval(() => {
  if (wss.clients.size === 0) return;
  const sample = {
    id: Date.now(),
    type: 'slow_pr',
    severity: 'medium',
    detected_at: new Date().toISOString(),
    details: { note: 'simulated live push for demo purposes' },
  };
  wss.clients.forEach(client => client.readyState === 1 && client.send(JSON.stringify(sample)));
}, 45000);

const PORT = process.env.PORT || 4000;

bootstrap()
  .then(() => {
    scheduleLiveRefresh();
    server.listen(PORT, () => console.log(`Engineering dashboard API listening on :${PORT} (data source: ${dataSource})`));
  })
  .catch((err) => {
    console.error('[server] fatal error during bootstrap:', err);
    process.exit(1);
  });

module.exports = app;
