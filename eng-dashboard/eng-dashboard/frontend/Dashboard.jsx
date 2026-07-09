import React, { useState, useMemo } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot,
} from "recharts";
import { AlertTriangle, TrendingDown, GitPullRequest, GitMerge, Rocket, Filter } from "lucide-react";

// ---------------------------------------------------------------------------
// Mock data engine — mirrors backend/services/mockGitlab.js + metrics.js + anomalies.js
// so this artifact runs standalone. In production this file's fetch layer would call
// the real /api/v1/* endpoints documented in ARCHITECTURE.md instead of generating data.
// ---------------------------------------------------------------------------
const TEAMS = [
  { id: "1", name: "Payments" },
  { id: "2", name: "Platform" },
  { id: "3", name: "Growth" },
];
const DEVELOPERS = [
  { id: "101", username: "jsingh", name: "Jyoti Singh", team_id: "1" },
  { id: "102", username: "mrivera", name: "Marco Rivera", team_id: "1" },
  { id: "103", username: "lchen", name: "Lily Chen", team_id: "2" },
  { id: "104", username: "aokoye", name: "Ada Okoye", team_id: "2" },
  { id: "105", username: "ppatel", name: "Priya Patel", team_id: "3" },
  { id: "106", username: "dkim", name: "David Kim", team_id: "3" },
];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}
const rnd = seededRandom(42);
const randInt = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;
const pick = (arr) => arr[randInt(0, arr.length - 1)];

function generateDataset(days = 90) {
  const now = new Date("2026-07-06T00:00:00Z");
  const start = new Date(now.getTime() - days * 86400000);
  const mrs = [];
  let id = 1000;

  for (let d = 0; d < days; d++) {
    const dayStart = new Date(start.getTime() + d * 86400000);
    const count = randInt(2, 7);
    for (let i = 0; i < count; i++) {
      const dev = pick(DEVELOPERS);
      const createdAt = new Date(dayStart.getTime() + rnd() * 20 * 3600000);
      let turnaroundHrs = 2 + rnd() * 28;
      const isSlow = rnd() < 0.045;
      if (isSlow) turnaroundHrs = 96 + rnd() * 144;
      const mergedAt = new Date(createdAt.getTime() + turnaroundHrs * 3600000);

      let additions = randInt(10, 300);
      let deletions = randInt(5, Math.floor(additions * 0.4));
      const isChurny = rnd() < 0.05;
      if (isChurny) { additions = randInt(50, 150); deletions = randInt(120, 400); }
      const total = additions + deletions;
      const modified = Math.min(additions, deletions) * 2;

      mrs.push({
        id: id++, team_id: dev.team_id, dev_id: dev.id,
        created_at: createdAt, merged_at: mergedAt,
        turnaround_hrs: turnaroundHrs,
        churn_ratio: total ? modified / total : 0,
        is_slow_flag: isSlow, is_churn_flag: isChurny,
      });
    }
  }

  const deploys = [];
  let did = 5000;
  const weeks = Math.ceil(days / 7);
  for (const team of TEAMS) {
    for (let w = 0; w < weeks; w++) {
      const weekStart = new Date(start.getTime() + w * 7 * 86400000);
      let n = randInt(8, 15);
      const isDrop = team.id === "2" && w === weeks - 1;
      if (isDrop) n = randInt(1, 3);
      for (let i = 0; i < n; i++) {
        deploys.push({
          id: did++, team_id: team.id,
          created_at: new Date(weekStart.getTime() + rnd() * 7 * 86400000),
          is_drop_flag: isDrop,
        });
      }
    }
  }
  return { mrs, deploys, rangeStart: start, rangeEnd: now };
}

const DATASET = generateDataset(90);

// ---- metric helpers (mirror backend/services/metrics.js) ----
const median = (vals) => {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const mean = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
const mad = (vals) => {
  const m = median(vals);
  return median(vals.map((v) => Math.abs(v - m))) || 1;
};
const weekKey = (d) => {
  const dt = new Date(d);
  const day = dt.getUTCDay();
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() - day);
  return monday.toISOString().slice(0, 10);
};
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

function filterData({ team, developer, from, to }) {
  const mrs = DATASET.mrs.filter((m) => {
    if (team !== "all" && m.team_id !== team) return false;
    if (developer !== "all" && m.dev_id !== developer) return false;
    if (from && m.merged_at < from) return false;
    if (to && m.merged_at > to) return false;
    return true;
  });
  const deploys = DATASET.deploys.filter((d) => {
    if (team !== "all" && d.team_id !== team) return false;
    if (from && d.created_at < from) return false;
    if (to && d.created_at > to) return false;
    return true;
  });
  return { mrs, deploys };
}

function computeKPIs(mrs, deploys, weeks) {
  const turnarounds = mrs.map((m) => m.turnaround_hrs);
  const churns = mrs.map((m) => m.churn_ratio);
  return {
    turnaroundAvg: mean(turnarounds),
    turnaroundMedian: median(turnarounds),
    churnAvg: mean(churns),
    deployPerWeek: weeks > 0 ? deploys.length / weeks : 0,
    sample: mrs.length,
  };
}

function buildTrend(mrs, field, bucketFn) {
  const buckets = {};
  for (const m of mrs) {
    const k = bucketFn(m.merged_at);
    (buckets[k] ||= []).push(m[field]);
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({ date, value: Number(mean(vals).toFixed(field === "churn_ratio" ? 3 : 1)) }));
}

function buildDeployTrend(deploys) {
  const buckets = {};
  for (const d of deploys) {
    const k = weekKey(d.created_at);
    buckets[k] = (buckets[k] || 0) + 1;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, count]) => ({ date: week, value: count }));
}

// ---- anomaly detectors (mirror backend/services/anomalies.js) ----
function detectAnomalies(mrs, deploys) {
  const out = [];

  // 1) slow PR
  const turnarounds = mrs.map((m) => m.turnaround_hrs);
  const base = median(turnarounds);
  const spread = mad(turnarounds);
  const threshold = Math.max(base + 2 * spread, 48);
  mrs.forEach((m) => {
    if (m.turnaround_hrs > threshold) {
      const dev = DEVELOPERS.find((d) => d.id === m.dev_id);
      out.push({
        type: "slow_pr", severity: m.turnaround_hrs > threshold * 1.8 ? "high" : "medium",
        label: `Slow PR — ${dev?.name ?? "unknown"}`,
        detail: `${m.turnaround_hrs.toFixed(0)}h to merge vs ${threshold.toFixed(0)}h threshold`,
        date: dayKey(m.merged_at), value: m.turnaround_hrs,
      });
    }
  });

  // 2) high churn (per developer, min sample 5)
  const byDev = {};
  mrs.forEach((m) => (byDev[m.dev_id] ||= []).push(m.churn_ratio));
  const allChurn = mrs.map((m) => m.churn_ratio);
  const churnBase = median(allChurn);
  const churnSpread = mad(allChurn) || 0.05;
  const churnThreshold = churnBase + 2 * churnSpread;
  Object.entries(byDev).forEach(([devId, ratios]) => {
    if (ratios.length < 5) return;
    const avg = mean(ratios);
    if (avg > churnThreshold) {
      const dev = DEVELOPERS.find((d) => d.id === devId);
      out.push({
        type: "high_churn", severity: avg > churnThreshold * 1.5 ? "high" : "medium",
        label: `High code churn — ${dev?.name ?? "unknown"}`,
        detail: `${(avg * 100).toFixed(0)}% churn ratio vs ${(churnThreshold * 100).toFixed(0)}% threshold`,
        value: avg,
      });
    }
  });

  // 3) deployment drop (per team, trailing baseline)
  TEAMS.forEach((team) => {
    const teamDeploys = deploys.filter((d) => d.team_id === team.id);
    const weekly = {};
    teamDeploys.forEach((d) => { const k = weekKey(d.created_at); weekly[k] = (weekly[k] || 0) + 1; });
    const weeksArr = Object.entries(weekly).sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => c);
    if (weeksArr.length < 3) return;
    const current = weeksArr[weeksArr.length - 1];
    const priorBase = median(weeksArr.slice(0, -1));
    if (priorBase > 0 && current < priorBase * 0.5) {
      const dropPct = Math.round((1 - current / priorBase) * 100);
      out.push({
        type: "deployment_drop", severity: dropPct > 75 ? "high" : "medium",
        label: `Deployment drop — ${team.name}`,
        detail: `${current} deploys this week vs baseline ${priorBase.toFixed(0)} (${dropPct}% drop)`,
        value: current,
      });
    }
  });

  return out;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const COLORS = {
  bg: "#0B0D12", panel: "#12151C", panelBorder: "#1F2430", text: "#E6E8EB",
  muted: "#7C8598", accentCyan: "#4FD1C5", accentAmber: "#F0A93A",
  accentRed: "#F0546A", accentGreen: "#3DD68C", grid: "#1B2029",
};

function SeverityBadge({ severity }) {
  const map = {
    high: { bg: "rgba(240,84,106,0.15)", fg: COLORS.accentRed, label: "HIGH" },
    medium: { bg: "rgba(240,169,58,0.15)", fg: COLORS.accentAmber, label: "MED" },
    low: { bg: "rgba(124,133,152,0.15)", fg: COLORS.muted, label: "LOW" },
  };
  const s = map[severity] ?? map.low;
  return (
    <span style={{
      background: s.bg, color: s.fg, fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5,
    }}>{s.label}</span>
  );
}

function AnomalyIcon({ type }) {
  const style = { width: 16, height: 16 };
  if (type === "slow_pr") return <GitPullRequest style={{ ...style, color: COLORS.accentAmber }} />;
  if (type === "high_churn") return <GitMerge style={{ ...style, color: COLORS.accentRed }} />;
  return <TrendingDown style={{ ...style, color: COLORS.accentRed }} />;
}

function KPICard({ icon, label, value, unit, sub, accent }) {
  return (
    <div style={{
      background: COLORS.panel, border: `1px solid ${COLORS.panelBorder}`, borderRadius: 10,
      padding: "18px 20px", flex: 1, minWidth: 200,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        {icon}
        <span style={{ color: COLORS.muted, fontSize: 12, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
          {label}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 32, fontWeight: 700, color: accent }}>
          {value}
        </span>
        <span style={{ color: COLORS.muted, fontSize: 14 }}>{unit}</span>
      </div>
      <div style={{ color: COLORS.muted, fontSize: 12, marginTop: 6 }}>{sub}</div>
    </div>
  );
}

function ChartPanel({ title, children, height = 220 }) {
  return (
    <div style={{
      background: COLORS.panel, border: `1px solid ${COLORS.panelBorder}`, borderRadius: 10,
      padding: "16px 18px", flex: 1, minWidth: 320,
    }}>
      <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{title}</div>
      <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
    </div>
  );
}

const tooltipStyle = {
  background: COLORS.panel, border: `1px solid ${COLORS.panelBorder}`, borderRadius: 8,
  fontSize: 12, color: COLORS.text,
};

export default function EngProductivityDashboard() {
  const [team, setTeam] = useState("all");
  const [developer, setDeveloper] = useState("all");
  const [rangeDays, setRangeDays] = useState(30);

  const to = DATASET.rangeEnd;
  const from = new Date(to.getTime() - rangeDays * 86400000);

  const availableDevs = useMemo(
    () => (team === "all" ? DEVELOPERS : DEVELOPERS.filter((d) => d.team_id === team)),
    [team]
  );

  const { mrs, deploys } = useMemo(
    () => filterData({ team, developer, from, to }),
    [team, developer, rangeDays]
  );

  const weeks = Math.max(1, rangeDays / 7);
  const kpis = useMemo(() => computeKPIs(mrs, deploys, weeks), [mrs, deploys, weeks]);
  const turnaroundTrend = useMemo(() => buildTrend(mrs, "turnaround_hrs", dayKey), [mrs]);
  const churnTrend = useMemo(() => buildTrend(mrs, "churn_ratio", dayKey), [mrs]);
  const deployTrend = useMemo(() => buildDeployTrend(deploys), [deploys]);
  const anomalies = useMemo(() => detectAnomalies(mrs, deploys), [mrs, deploys]);

  const selectStyle = {
    background: COLORS.panel, color: COLORS.text, border: `1px solid ${COLORS.panelBorder}`,
    borderRadius: 6, padding: "6px 10px", fontSize: 13, outline: "none", cursor: "pointer",
  };

  return (
    <div style={{
      background: COLORS.bg, minHeight: "100vh", padding: 24,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ color: COLORS.text, fontSize: 20, fontWeight: 700 }}>Engineering Productivity</div>
          <div style={{ color: COLORS.muted, fontSize: 12, marginTop: 2 }}>
            GitLab-sourced metrics · {DATASET.mrs.length.toLocaleString()} MRs indexed · updated live
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Filter style={{ width: 14, height: 14, color: COLORS.muted }} />
          <select style={selectStyle} value={team} onChange={(e) => { setTeam(e.target.value); setDeveloper("all"); }}>
            <option value="all">All teams</option>
            {TEAMS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select style={selectStyle} value={developer} onChange={(e) => setDeveloper(e.target.value)}>
            <option value="all">All developers</option>
            {availableDevs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select style={selectStyle} value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {/* Anomaly banner */}
      {anomalies.length > 0 && (
        <div style={{
          background: "rgba(240,84,106,0.08)", border: `1px solid rgba(240,84,106,0.3)`,
          borderRadius: 10, padding: "12px 16px", marginBottom: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <AlertTriangle style={{ width: 16, height: 16, color: COLORS.accentRed }} />
            <span style={{ color: COLORS.text, fontSize: 13, fontWeight: 700 }}>
              {anomalies.length} anomal{anomalies.length === 1 ? "y" : "ies"} detected in this window
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {anomalies.map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <AnomalyIcon type={a.type} />
                <SeverityBadge severity={a.severity} />
                <span style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>{a.label}</span>
                <span style={{ color: COLORS.muted, fontSize: 12 }}>— {a.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
        <KPICard
          icon={<GitPullRequest style={{ width: 15, height: 15, color: COLORS.accentCyan }} />}
          label="PR Turnaround" value={kpis.turnaroundAvg.toFixed(1)} unit="hrs avg"
          sub={`median ${kpis.turnaroundMedian.toFixed(1)}h · ${kpis.sample} PRs`}
          accent={COLORS.accentCyan}
        />
        <KPICard
          icon={<GitMerge style={{ width: 15, height: 15, color: COLORS.accentAmber }} />}
          label="Code Churn" value={(kpis.churnAvg * 100).toFixed(0)} unit="% ratio"
          sub="modified / total changed lines"
          accent={COLORS.accentAmber}
        />
        <KPICard
          icon={<Rocket style={{ width: 15, height: 15, color: COLORS.accentGreen }} />}
          label="Deploy Frequency" value={kpis.deployPerWeek.toFixed(1)} unit="/ week"
          sub={`${deploys.length} successful deploys`}
          accent={COLORS.accentGreen}
        />
      </div>

      {/* Trend charts */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <ChartPanel title="PR Turnaround Time (hrs, daily avg)">
          <LineChart data={turnaroundTrend}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={{ stroke: COLORS.grid }} minTickGap={30} />
            <YAxis tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="value" stroke={COLORS.accentCyan} strokeWidth={2} dot={false} />
            {anomalies.filter((a) => a.type === "slow_pr").map((a, i) => {
              const pt = turnaroundTrend.find((t) => t.date === a.date);
              return pt ? <ReferenceDot key={i} x={pt.date} y={pt.value} r={4} fill={COLORS.accentRed} stroke="none" /> : null;
            })}
          </LineChart>
        </ChartPanel>

        <ChartPanel title="Code Churn Ratio (daily avg)">
          <AreaChart data={churnTrend}>
            <defs>
              <linearGradient id="churnFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.accentAmber} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLORS.accentAmber} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={{ stroke: COLORS.grid }} minTickGap={30} />
            <YAxis tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${(v * 100).toFixed(1)}%`} />
            <Area type="monotone" dataKey="value" stroke={COLORS.accentAmber} strokeWidth={2} fill="url(#churnFill)" />
          </AreaChart>
        </ChartPanel>

        <ChartPanel title="Deployment Frequency (per week)">
          <BarChart data={deployTrend}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {deployTrend.map((d, i) => {
                const isLast = i === deployTrend.length - 1;
                const isDropTeam = team === "2" || team === "all";
                const flagged = isLast && isDropTeam && anomalies.some((a) => a.type === "deployment_drop");
                return <rect key={i} fill={flagged ? COLORS.accentRed : COLORS.accentGreen} />;
              })}
            </Bar>
          </BarChart>
        </ChartPanel>
      </div>

      <div style={{ color: COLORS.muted, fontSize: 11, marginTop: 18, textAlign: "center" }}>
        Mock data for demo purposes · production version reads from /api/v1/* backed by GitLab-synced Postgres
      </div>
    </div>
  );
}
