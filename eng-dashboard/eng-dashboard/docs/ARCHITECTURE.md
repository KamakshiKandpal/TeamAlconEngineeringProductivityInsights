# Engineering Productivity Dashboard — Design Doc

## 1. Architecture

```
                         ┌────────────────────────────────────────┐
                         │              GitLab (source)            │
                         │  REST/GraphQL API + Webhooks             │
                         └───────────────┬──────────────────────────┘
                                          │
              ┌───────────────────────────┴───────────────────────────┐
              │                                                        │
      (A) Webhook events                                    (B) Scheduled sync
      MR merged / opened,                                    (cron, every 5–15 min)
      pipeline/deployment                                     backfill + reconciliation
              │                                                        │
              ▼                                                        ▼
   ┌───────────────────────┐                          ┌───────────────────────────┐
   │  Ingestion Service     │                          │   Sync Worker (BullMQ /    │
   │  (Express webhook      │ ───────► Kafka/Redis ───►│   Sidekiq-style queue)     │
   │  receiver, verifies    │          Streams          │   Paginates GitLab API,   │
   │  X-Gitlab-Token)       │                            │   rate-limit aware        │
   └───────────────────────┘                          └───────────────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │   Normalizer / ETL Consumer      │
                         │   - maps raw GitLab payload      │
                         │   - computes derived metrics     │
                         │   - upserts into Postgres        │
                         └───────────────┬───────────────────┘
                                          ▼
                         ┌─────────────────────────────────┐
                         │   PostgreSQL (OLTP + rollups)     │
                         │   raw tables + materialized       │
                         │   views for weekly/daily rollups  │
                         └───────────────┬───────────────────┘
                                          │
                     ┌────────────────────┴─────────────────────┐
                     ▼                                           ▼
        ┌─────────────────────────┐                 ┌─────────────────────────────┐
        │  Anomaly Detection Job    │                 │   Metrics/Query API (REST)   │
        │  (runs on rollup change,  │                 │   Node/Express, cached with  │
        │  writes to anomalies tbl)│                 │   Redis (TTL 60s)            │
        └─────────────────────────┘                 └───────────────┬─────────────┘
                     │                                               │
                     ▼                                               ▼
              WebSocket / SSE push                          ┌─────────────────────┐
              (real-time anomaly alert)                     │   React Dashboard     │
                     └────────────────────────────────────► │   (KPI cards, charts, │
                                                              │   filters)            │
                                                              └─────────────────────┘
```

**Why this shape**
- **Webhooks for real-time**, **scheduled sync for correctness** (webhooks can be missed/duplicated — the sync worker reconciles).
- **Queue between ingestion and processing** so a burst of MR events (e.g. mass merge) doesn't block the webhook receiver or hit GitLab rate limits (2000 req/min for GitLab.com, lower for self-managed).
- **Materialized views / rollup tables** so dashboard queries never scan raw event tables — this is what makes it scalable as history grows to millions of MRs/pipelines.
- **Redis cache** in front of the query API absorbs repeated identical filter combinations (a whole team looking at "last 30 days" dashboard).
- **WebSocket/SSE** pushes newly detected anomalies to open dashboards without polling — this is the "real-time" piece; regular metrics can be near-real-time (poll every 30–60s or on webhook-triggered invalidation).

## 2. GitLab API — Endpoints & Sample Responses

### 2.1 Merge Requests (PR turnaround)
`GET /api/v4/projects/:id/merge_requests?state=merged&updated_after=...&per_page=100`

```json
{
  "id": 155016,
  "iid": 421,
  "project_id": 8234,
  "title": "Add retry logic to payment webhook",
  "state": "merged",
  "created_at": "2026-06-30T09:12:44.000Z",
  "updated_at": "2026-07-01T14:03:10.000Z",
  "merged_at": "2026-07-01T14:03:10.000Z",
  "closed_at": null,
  "target_branch": "main",
  "source_branch": "feature/webhook-retry",
  "author": { "id": 512, "username": "jsingh", "name": "Jyoti Singh" },
  "assignees": [{ "id": 88, "username": "mrivera" }],
  "reviewers": [{ "id": 88, "username": "mrivera" }],
  "labels": ["team::payments", "type::feature"],
  "draft": false,
  "work_in_progress": false,
  "merge_status": "can_be_merged",
  "user_notes_count": 6,
  "changes_count": "3"
}
```

### 2.2 MR Diff stats (code churn)
`GET /api/v4/projects/:id/merge_requests/:iid/changes`

```json
{
  "iid": 421,
  "changes": [
    {
      "old_path": "src/payments/webhook.ts",
      "new_path": "src/payments/webhook.ts",
      "diff": "@@ -12,6 +12,18 @@ ...",
      "new_file": false,
      "renamed_file": false,
      "deleted_file": false
    }
  ]
}
```
Line counts are derived by parsing the unified diff (`+`/`-` line prefixes), or more cheaply via:
`GET /api/v4/projects/:id/repository/commits/:sha/diff` combined with
`GET /api/v4/projects/:id/merge_requests/:iid` → `changes_count`,
or the lightweight `resource states` endpoint. For scale, prefer:
`GET /api/v4/projects/:id/merge_requests/:iid?include_diverged_commits_count=true`
plus the **commit stats** endpoint which returns additions/deletions directly:

```json
{
  "id": "6104942438c14ec7bd21c6cd5bd995272204f6b",
  "stats": { "additions": 143, "deletions": 21, "total": 164 }
}
```

### 2.3 Deployments (deployment frequency)
`GET /api/v4/projects/:id/deployments?environment=production&status=success&order_by=created_at`

```json
{
  "id": 998812,
  "iid": 341,
  "ref": "main",
  "sha": "6104942438c14ec7bd21c6cd5bd995272204f6b",
  "status": "success",
  "created_at": "2026-07-01T14:10:02.000Z",
  "updated_at": "2026-07-01T14:14:55.000Z",
  "finished_at": "2026-07-01T14:14:55.000Z",
  "environment": { "id": 12, "name": "production", "external_url": "https://app.example.com" },
  "deployable": {
    "id": 55231,
    "status": "success",
    "pipeline": { "id": 77234, "ref": "main" },
    "user": { "id": 512, "username": "jsingh" }
  }
}
```

### 2.4 Users/Teams (for filters)
`GET /api/v4/groups/:id/members` and GitLab **group labels** (e.g. `team::payments`) are used as the team dimension since GitLab has no first-class "team" object at the project level.

### Rate limits & pagination
- Use `per_page=100` + `Link` header pagination, never offset-based for large ranges.
- Respect `RateLimit-Remaining` / `Retry-After` headers; sync worker backs off exponentially.
- Prefer GitLab **GraphQL API** for MR+diffStats+approvals in one call where self-managed GitLab supports it (reduces N+1 REST calls per MR).

## 3. Database Schema (PostgreSQL)

```sql
-- Dimension tables
CREATE TABLE teams (
  id            SERIAL PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,       -- derived from gitlab label "team::<name>"
  gitlab_label  TEXT UNIQUE NOT NULL
);

CREATE TABLE developers (
  id            SERIAL PRIMARY KEY,
  gitlab_user_id BIGINT UNIQUE NOT NULL,
  username      TEXT NOT NULL,
  display_name  TEXT,
  team_id       INT REFERENCES teams(id)
);

CREATE TABLE projects (
  id              SERIAL PRIMARY KEY,
  gitlab_project_id BIGINT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  team_id         INT REFERENCES teams(id)
);

-- Fact table: merge requests
CREATE TABLE merge_requests (
  id                SERIAL PRIMARY KEY,
  gitlab_mr_id      BIGINT UNIQUE NOT NULL,
  project_id        INT REFERENCES projects(id),
  author_id         INT REFERENCES developers(id),
  team_id           INT REFERENCES teams(id),
  title             TEXT,
  created_at        TIMESTAMPTZ NOT NULL,
  merged_at         TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  state             TEXT CHECK (state IN ('opened','merged','closed')),
  additions         INT DEFAULT 0,
  deletions         INT DEFAULT 0,
  modified_lines    INT DEFAULT 0,          -- additions + deletions on already-existing lines
  total_changed_lines INT DEFAULT 0,        -- additions + deletions (all)
  turnaround_seconds INT GENERATED ALWAYS AS
     (EXTRACT(EPOCH FROM (merged_at - created_at))::INT) STORED,
  churn_ratio       NUMERIC(5,4),           -- modified_lines / NULLIF(total_changed_lines,0)
  raw_payload       JSONB,                  -- full GitLab response for audit/replay
  ingested_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_mr_merged_at ON merge_requests (merged_at);
CREATE INDEX idx_mr_team_time ON merge_requests (team_id, merged_at);
CREATE INDEX idx_mr_author_time ON merge_requests (author_id, merged_at);

-- Fact table: deployments
CREATE TABLE deployments (
  id                SERIAL PRIMARY KEY,
  gitlab_deployment_id BIGINT UNIQUE NOT NULL,
  project_id        INT REFERENCES projects(id),
  team_id           INT REFERENCES teams(id),
  environment       TEXT,
  status            TEXT,
  triggered_by_id   INT REFERENCES developers(id),
  created_at        TIMESTAMPTZ NOT NULL,
  finished_at       TIMESTAMPTZ,
  sha               TEXT,
  raw_payload       JSONB,
  ingested_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_deploy_team_time ON deployments (team_id, created_at);

-- Rollup / materialized views (refreshed by ETL or trigger)
CREATE MATERIALIZED VIEW mv_weekly_team_metrics AS
SELECT
  team_id,
  date_trunc('week', COALESCE(merged_at, created_at)) AS week,
  COUNT(*) FILTER (WHERE state = 'merged')                         AS merged_prs,
  AVG(turnaround_seconds) FILTER (WHERE state = 'merged')          AS avg_turnaround_sec,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY turnaround_seconds)
      FILTER (WHERE state='merged')                                AS median_turnaround_sec,
  AVG(churn_ratio) FILTER (WHERE state = 'merged')                 AS avg_churn_ratio
FROM merge_requests
GROUP BY team_id, date_trunc('week', COALESCE(merged_at, created_at));

CREATE MATERIALIZED VIEW mv_weekly_deploy_freq AS
SELECT
  team_id,
  date_trunc('week', created_at) AS week,
  COUNT(*) FILTER (WHERE status = 'success') AS deployments
FROM deployments
GROUP BY team_id, date_trunc('week', created_at);

-- Anomalies (written by detection job, read by API + pushed via WS)
CREATE TABLE anomalies (
  id            SERIAL PRIMARY KEY,
  type          TEXT CHECK (type IN ('slow_pr','high_churn','deployment_drop')),
  severity      TEXT CHECK (severity IN ('low','medium','high')),
  team_id       INT REFERENCES teams(id),
  developer_id  INT REFERENCES developers(id),
  entity_type   TEXT,             -- 'merge_request' | 'deployment_window'
  entity_id     BIGINT,
  metric_value  NUMERIC,
  baseline_value NUMERIC,
  detected_at   TIMESTAMPTZ DEFAULT now(),
  window_start  TIMESTAMPTZ,
  window_end    TIMESTAMPTZ,
  details       JSONB,
  acknowledged  BOOLEAN DEFAULT false
);
CREATE INDEX idx_anomalies_detected ON anomalies (detected_at DESC);
```

Scale notes: `merge_requests` and `deployments` are append-mostly and partition well by month (`PARTITION BY RANGE (created_at)`) once volume grows past a few million rows. Materialized views are refreshed incrementally (`REFRESH MATERIALIZED VIEW CONCURRENTLY`) on a 5-minute cadence, driven by the ETL consumer rather than a blind cron, so dashboards stay near-real-time without recomputing on every request.

## 4. Metric Formulas

| Metric | Formula | Notes |
|---|---|---|
| **PR Turnaround Time** | `merged_at - created_at` per MR, then `avg()` or `median()` over the filtered set | Median is reported alongside mean because turnaround is heavy-tailed (a few multi-week MRs skew the average). Excludes MRs still open. |
| **Code Churn Ratio** | `modified_lines / total_changed_lines` where `total_changed_lines = additions + deletions` and `modified_lines` = lines touched that were edited again within N days of first being added (rework), approximated here as `min(additions, deletions) * 2` when line-level blame isn't available, or precisely via `git log -p` blame-diffing in a deeper pipeline | High ratio ⇒ lots of rewriting/thrash rather than net-new code. |
| **Deployment Frequency** | `count(deployments WHERE status='success' AND environment='production') / weeks_in_range` | Reported per team per week; DORA-aligned metric. |

```
turnaround_hours   = (merged_at - created_at) / 3600
churn_ratio        = modified_lines / total_changed_lines      (0..1)
deploy_frequency   = successful_prod_deployments / week_count
```

## 5. Backend API

```
GET  /api/v1/kpis?team=&developer=&from=&to=
GET  /api/v1/trends/pr-turnaround?team=&developer=&from=&to=&granularity=day|week
GET  /api/v1/trends/code-churn?team=&developer=&from=&to=&granularity=day|week
GET  /api/v1/trends/deployment-frequency?team=&from=&to=
GET  /api/v1/anomalies?type=&team=&from=&to=&acknowledged=false
POST /api/v1/anomalies/:id/ack
GET  /api/v1/filters/teams
GET  /api/v1/filters/developers?team=
WS   /ws/anomalies                 -- pushes new anomaly rows as they're written
```

Cross-cutting: JWT auth (GitLab OAuth), Redis response cache keyed by `hash(query params)` with 60s TTL, invalidated early when the ETL consumer commits new rollups for the affected team/week.

## 6. Anomaly / Insight Logic

All three detectors run as a scheduled job (every 5–15 min) over the latest rollup window, comparing against a **trailing baseline** (median + MAD, which is robust to outliers, rather than mean + stddev):

1. **Slow PR** — an individual MR's `turnaround_seconds` > `median(team's last 30d turnaround) + 2 * MAD`, AND turnaround > an absolute floor (e.g. 48h) to avoid flagging noise on a fast-moving team. Severity scales with how many MAD it exceeds by.
2. **High Code Churn** — a developer's or team's rolling 7-day `avg(churn_ratio)` exceeds `baseline + 2 * MAD`, with a minimum sample size (≥5 MRs) so one small PR doesn't trigger a false alarm.
3. **Deployment Drop** — current week's deployment count for a team falls below `baseline_median * 0.5` (configurable threshold), where baseline is the median of the prior 4 weeks, excluding weeks already flagged as anomalous (so a real drop doesn't get "normalized away").

Each detector writes a row to `anomalies` with `metric_value`, `baseline_value`, and a human-readable `details` blob, and publishes over the WebSocket channel so open dashboards get a live toast/badge without polling.
