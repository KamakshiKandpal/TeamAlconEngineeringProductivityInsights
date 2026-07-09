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
