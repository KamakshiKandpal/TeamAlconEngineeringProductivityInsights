/**
 * services/insights.js
 * Turns the computed KPI + anomaly payload into a short, actionable insight summary for
 * engineering leaders.
 *
 * When a Claude API key is configured (CLAUDE_API_KEY or ANTHROPIC_API_KEY) it asks Claude
 * to write the summary from the live metrics. When no key is set, or the API call fails, it
 * falls back to a deterministic locally-computed summary so the dashboard keeps working with
 * zero credentials — this is the "keep the mock/static values as fallback" behaviour.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-4-8';

/** Human-readable summary computed purely from the payload — no network, always available. */
function buildFallbackSummary(payload) {
  const { kpis = {}, anomalies = [] } = payload;
  const turnaround = kpis.pr_turnaround || {};
  const churn = kpis.code_churn || {};
  const deploy = kpis.deployment_frequency || {};

  const parts = [];

  if (turnaround.avg_hours != null) {
    const slow = turnaround.avg_hours > 48;
    parts.push(
      `PR turnaround is averaging ${turnaround.avg_hours}h (median ${turnaround.median_hours ?? '—'}h) across ${turnaround.sample_size ?? 0} merged PRs` +
        (slow ? ' — above the 48h threshold, pointing to review bottlenecks.' : ' — comfortably within the 48h target.')
    );
  }
  if (churn.avg_ratio != null) {
    const pct = Math.round(churn.avg_ratio * 100);
    parts.push(`Code churn sits at ${pct}% (rework vs. total changed lines)${pct > 30 ? ', elevated enough to suggest requirements or design thrash.' : ', a healthy sign of net-new work.'}`);
  }
  if (deploy.per_week != null) {
    parts.push(`Deployment frequency is ${deploy.per_week}/week (${deploy.total ?? 0} successful deploys in range).`);
  }

  if (anomalies.length) {
    const high = anomalies.filter(a => a.severity === 'high').length;
    parts.push(
      `${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} detected${high ? `, ${high} high-severity` : ''}. ` +
        'Focus first on the flagged slow PRs and any deployment drops to unblock delivery.'
    );
  } else {
    parts.push('No anomalies detected in this window — delivery signals look stable.');
  }

  return parts.join(' ');
}

/**
 * Ask Claude to summarise the metrics.
 * @param {object} payload  { kpis, anomalies }
 * @param {object} opts     { apiKey }
 * @returns {Promise<{summary, source, generatedAt}>}
 */
async function buildInsightSummary(payload, { apiKey } = {}) {
  const generatedAt = new Date().toISOString();

  // No key configured → deterministic fallback (still fully functional).
  if (!apiKey) {
    return { summary: buildFallbackSummary(payload), source: 'fallback', generatedAt };
  }

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You are an analytics assistant for engineering leaders. Given engineering productivity ' +
        'metrics (PR turnaround, code churn, deployment frequency) and detected anomalies, write a ' +
        'concise, actionable insight summary of 2-4 sentences. Lead with the most important signal. ' +
        'Be specific with numbers, call out bottlenecks or risks, and suggest where to focus. ' +
        'Plain prose only — no markdown, headings, or bullet points.',
      messages: [
        {
          role: 'user',
          content:
            'Here are the current engineering productivity metrics and anomalies as JSON. ' +
            'Write the insight summary.\n\n' +
            JSON.stringify(payload, null, 2),
        },
      ],
    });

    const summary = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    if (!summary) {
      return { summary: buildFallbackSummary(payload), source: 'fallback', generatedAt };
    }

    return { summary, source: 'anthropic', generatedAt, model: response.model };
  } catch (error) {
    // Network error, invalid key, refusal, etc. — never break the dashboard.
    console.error('[insights] Claude API call failed, using fallback summary:', error.message);
    return { summary: buildFallbackSummary(payload), source: 'fallback', generatedAt };
  }
}

module.exports = { buildInsightSummary, buildFallbackSummary };
