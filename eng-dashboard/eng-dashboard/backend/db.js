/**
 * db.js
 * Minimal Postgres access layer for production use, matching backend/db/schema.sql.
 * Uses `pg`'s connection pool. All writes are idempotent upserts keyed on the GitLab id,
 * so re-running a sync (e.g. after a crash, or via the reconciliation cron) is always safe.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // e.g. postgres://user:pass@host:5432/eng_dashboard
  max: 10,
  idleTimeoutMillis: 30000,
});

async function upsertTeam({ name, gitlab_label }) {
  const { rows } = await pool.query(
    `INSERT INTO teams (name, gitlab_label) VALUES ($1, $2)
     ON CONFLICT (gitlab_label) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, gitlab_label]
  );
  return rows[0].id;
}

async function upsertDeveloper({ gitlab_user_id, username, display_name, team_id }) {
  const { rows } = await pool.query(
    `INSERT INTO developers (gitlab_user_id, username, display_name, team_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (gitlab_user_id) DO UPDATE
       SET username = EXCLUDED.username, display_name = EXCLUDED.display_name, team_id = EXCLUDED.team_id
     RETURNING id`,
    [gitlab_user_id, username, display_name, team_id]
  );
  return rows[0].id;
}

async function upsertProject({ gitlab_project_id, name, team_id }) {
  const { rows } = await pool.query(
    `INSERT INTO projects (gitlab_project_id, name, team_id) VALUES ($1, $2, $3)
     ON CONFLICT (gitlab_project_id) DO UPDATE SET name = EXCLUDED.name, team_id = EXCLUDED.team_id
     RETURNING id`,
    [gitlab_project_id, name, team_id]
  );
  return rows[0].id;
}

async function upsertMergeRequest(mr) {
  await pool.query(
    `INSERT INTO merge_requests
       (gitlab_mr_id, project_id, author_id, team_id, title, created_at, merged_at, closed_at,
        state, additions, deletions, modified_lines, total_changed_lines, churn_ratio, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (gitlab_mr_id) DO UPDATE SET
       state = EXCLUDED.state, merged_at = EXCLUDED.merged_at, closed_at = EXCLUDED.closed_at,
       additions = EXCLUDED.additions, deletions = EXCLUDED.deletions,
       modified_lines = EXCLUDED.modified_lines, total_changed_lines = EXCLUDED.total_changed_lines,
       churn_ratio = EXCLUDED.churn_ratio, raw_payload = EXCLUDED.raw_payload`,
    [
      mr.gitlab_mr_id, mr.project_id, mr.author_id, mr.team_id, mr.title,
      mr.created_at, mr.merged_at, mr.closed_at, mr.state, mr.additions, mr.deletions,
      mr.modified_lines, mr.total_changed_lines, mr.churn_ratio, mr.raw_payload,
    ]
  );
}

async function upsertDeployment(d) {
  await pool.query(
    `INSERT INTO deployments
       (gitlab_deployment_id, project_id, team_id, environment, status, triggered_by_id,
        created_at, finished_at, sha, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (gitlab_deployment_id) DO UPDATE SET
       status = EXCLUDED.status, finished_at = EXCLUDED.finished_at, raw_payload = EXCLUDED.raw_payload`,
    [
      d.gitlab_deployment_id, d.project_id, d.team_id, d.environment, d.status,
      d.triggered_by_id, d.created_at, d.finished_at, d.sha, d.raw_payload,
    ]
  );
}

async function insertAnomaly(a) {
  await pool.query(
    `INSERT INTO anomalies
       (type, severity, team_id, developer_id, entity_type, entity_id, metric_value,
        baseline_value, window_start, window_end, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      a.type, a.severity, a.team_id, a.developer_id, a.entity_type, a.entity_id,
      a.metric_value, a.baseline_value, a.window_start, a.window_end, a.details,
    ]
  );
}

async function refreshRollups() {
  // CONCURRENTLY requires a unique index on the view; see db/schema.sql for the recommended setup.
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_weekly_team_metrics');
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_weekly_deploy_freq');
}

module.exports = {
  pool, upsertTeam, upsertDeveloper, upsertProject,
  upsertMergeRequest, upsertDeployment, insertAnomaly, refreshRollups,
};
