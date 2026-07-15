import React, { useState, useMemo, useEffect } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot, ReferenceLine, Legend,
} from "recharts";
import { AlertTriangle, TrendingDown, GitPullRequest, GitMerge, Rocket, Filter } from "lucide-react";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

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

function buildQueryString(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  });
  return search.toString();
}

function createMockDashboardData({ team = "all", developer = "all" } = {}) {
  const teams = [
    { id: "1", name: "Payments" },
    { id: "2", name: "Platform" },
    { id: "3", name: "Growth" },
  ];
  const developers = [
    { id: "101", username: "jsingh", name: "Jyoti Singh", team_id: "1" },
    { id: "102", username: "mrivera", name: "Marco Rivera", team_id: "1" },
    { id: "103", username: "lchen", name: "Lily Chen", team_id: "2" },
    { id: "104", username: "aokoye", name: "Ada Okoye", team_id: "2" },
    { id: "105", username: "ppatel", name: "Priya Patel", team_id: "3" },
    { id: "106", username: "dkim", name: "David Kim", team_id: "3" },
  ];

  const filteredTeams = team === "all" ? teams : teams.filter((item) => item.id === team);
  const filteredDevs = developer === "all"
    ? (team === "all" ? developers : developers.filter((item) => item.team_id === team))
    : developers.filter((item) => item.id === developer);

  const prTrend = [
    { date: "2026-06-30", value: 22.4 },
    { date: "2026-07-01", value: 18.2 },
    { date: "2026-07-02", value: 20.1 },
    { date: "2026-07-03", value: 16.8 },
    { date: "2026-07-04", value: 19.5 },
  ];
  const churnTrend = [
    { date: "2026-06-30", value: 0.18 },
    { date: "2026-07-01", value: 0.21 },
    { date: "2026-07-02", value: 0.16 },
    { date: "2026-07-03", value: 0.24 },
    { date: "2026-07-04", value: 0.19 },
  ];
  const deployTrend = [
    { date: "2026-06-30", deployments: 4 },
    { date: "2026-07-01", deployments: 6 },
    { date: "2026-07-02", deployments: 5 },
    { date: "2026-07-03", deployments: 7 },
    { date: "2026-07-04", deployments: 5 },
  ];

  return {
    teams: filteredTeams,
    developers: filteredDevs,
    kpis: {
      pr_turnaround: { avg_hours: 18.7, median_hours: 13.2, sample_size: 36 },
      code_churn: { avg_ratio: 0.2, sample_size: 36 },
      deployment_frequency: { per_week: 5.8, total: 29 },
    },
    prTrend,
    churnTrend,
    deployTrend,
    anomalies: [
      { type: "slow_pr", severity: "medium", label: "Slow PR — Marco Rivera", detail: "72h to merge vs 48h threshold", date: "2026-07-04" },
      { type: "high_churn", severity: "medium", label: "High churn — Lily Chen", detail: "24% churn ratio vs 18% baseline", date: "2026-07-03" },
    ],
    insight: {
      summary: "Mock showcase values are active because the live API is unavailable. Review the current flow for PR bottlenecks and deployment stability.",
    },
  };
}

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
const formatDateKey = (d) => new Date(d).toISOString().slice(0, 10);
const parseDateInput = (value, { endOfDay = false } = {}) => {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  return endOfDay
    ? new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999))
    : new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
};
const weekKey = (d) => {
  const dt = new Date(d);
  const day = dt.getUTCDay();
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() - day);
  return formatDateKey(monday);
};
const dayKey = (d) => formatDateKey(d);

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

function buildDeployStackData(deploys, from, to, teamFilter) {
  if (!deploys.length || !from || !to) return [];

  const totalDays = Math.max(1, Math.floor((to.getTime() - from.getTime()) / 86400000) + 1);
  const totalWeeks = Math.max(1, Math.ceil(totalDays / 7));
  const visibleTeams = teamFilter === "all"
    ? TEAMS
    : TEAMS.filter((t) => t.id === teamFilter);

  const buckets = {};
  for (let i = 0; i < totalWeeks; i++) {
    const weekStart = new Date(from.getTime() + i * 7 * 86400000);
    buckets[formatDateKey(weekStart)] = Object.fromEntries(visibleTeams.map((t) => [t.id, 0]));
  }

  for (const d of deploys) {
    const offsetDays = Math.floor((d.created_at.getTime() - from.getTime()) / 86400000);
    const weekIndex = Math.max(0, Math.min(totalWeeks - 1, Math.floor(offsetDays / 7)));
    const weekStart = new Date(from.getTime() + weekIndex * 7 * 86400000);
    const k = formatDateKey(weekStart);
    if (!buckets[k]) buckets[k] = Object.fromEntries(visibleTeams.map((t) => [t.id, 0]));
    const teamId = d.team_id;
    if (buckets[k][teamId] !== undefined) {
      buckets[k][teamId] += 1;
    }
  }

  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));
}

// Build user-wise PR turnaround data grouped by date
function buildUserWisePRTrend(mrs) {
  const buckets = {};
  for (const m of mrs) {
    const k = dayKey(m.merged_at);
    if (!buckets[k]) buckets[k] = {};
    const dev = DEVELOPERS.find((d) => d.id === m.dev_id);
    const devKey = dev?.name || "unknown";
    if (!buckets[k][devKey]) buckets[k][devKey] = [];
    buckets[k][devKey].push(m.turnaround_hrs);
  }
  
  // Convert to array with user-wise averages
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, devMap]) => {
      const userWiseData = Object.entries(devMap).map(([devName, hrs]) => ({
        dev: devName,
        avg: Number(mean(hrs).toFixed(1)),
        count: hrs.length,
      }));
      return { date, userWise: userWiseData };
    });
}

// Get PRs for a specific date with user details
function getPRsForDate(mrs, deploys, date) {
  const selected = mrs.filter((m) => dayKey(m.merged_at) === date);
  return selected.map((m) => {
    const dev = DEVELOPERS.find((d) => d.id === m.dev_id);
    const deploymentFrequency = deploys.filter(
      (d) => dayKey(d.created_at) === date && d.team_id === m.team_id
    ).length;
    return {
      id: m.id,
      developer: dev?.name || "unknown",
      turnaroundHrs: m.turnaround_hrs,
      isSlow: m.turnaround_hrs > 48,
      churnRatio: m.churn_ratio,
      createdAt: dayKey(m.created_at),
      mergedAt: dayKey(m.merged_at),
      deploymentFrequency,
    };
  });
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
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [customFromDate, setCustomFromDate] = useState(null);
  const [customToDate, setCustomToDate] = useState(null);
  const [selectedDateForDetail, setSelectedDateForDetail] = useState(null);
  const [selectedDetailDeveloper, setSelectedDetailDeveloper] = useState("all");
  const [hoveredPRId, setHoveredPRId] = useState(null);

  const to = useCustomRange && customToDate
    ? parseDateInput(customToDate, { endOfDay: true })
    : new Date();
  const from = useCustomRange && customFromDate
    ? parseDateInput(customFromDate)
    : new Date(to.getTime() - (Math.max(rangeDays, 1) - 1) * 86400000);

  const [dashboardTeams, setDashboardTeams] = useState(TEAMS);
  const [dashboardDevelopers, setDashboardDevelopers] = useState(DEVELOPERS);
  const [kpisData, setKpisData] = useState(null);
  const [prTrendData, setPrTrendData] = useState([]);
  const [churnTrendData, setChurnTrendData] = useState([]);
  const [deployTrendData, setDeployTrendData] = useState([]);
  const [anomalyData, setAnomalyData] = useState([]);
  const [insightData, setInsightData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const loadDashboard = async () => {
      try {
        setLoading(true);
        setError(null);
        const query = buildQueryString({
          team: team === "all" ? "" : team,
          developer: developer === "all" ? "" : developer,
          from: useCustomRange && customFromDate ? customFromDate : "",
          to: useCustomRange && customToDate ? customToDate : "",
        });

        const healthRes = await fetch(`${API_BASE_URL}/api/v1/health`, { signal: controller.signal });
        if (!healthRes.ok) throw new Error("Backend unavailable");

        const [teamsRes, devsRes, kpisRes, prRes, churnRes, deployRes, anomaliesRes, insightsRes] = await Promise.all([
          fetch(`${API_BASE_URL}/api/v1/filters/teams`, { signal: controller.signal }),
          fetch(`${API_BASE_URL}/api/v1/filters/developers${query ? `?${query}` : ""}`, { signal: controller.signal }),
          fetch(`${API_BASE_URL}/api/v1/kpis${query ? `?${query}` : ""}`, { signal: controller.signal }),
          fetch(`${API_BASE_URL}/api/v1/trends/pr-turnaround${query ? `?${query}` : ""}`, { signal: controller.signal }),
          fetch(`${API_BASE_URL}/api/v1/trends/code-churn${query ? `?${query}` : ""}`, { signal: controller.signal }),
          fetch(`${API_BASE_URL}/api/v1/trends/deployment-frequency${query ? `?${query}` : ""}`, { signal: controller.signal }),
          fetch(`${API_BASE_URL}/api/v1/anomalies${query ? `?${query}` : ""}`, { signal: controller.signal }),
          fetch(`${API_BASE_URL}/api/v1/insights${query ? `?${query}` : ""}`, { signal: controller.signal }),
        ]);

        if (!teamsRes.ok || !devsRes.ok || !kpisRes.ok || !prRes.ok || !churnRes.ok || !deployRes.ok || !anomaliesRes.ok || !insightsRes.ok) {
          throw new Error("Unable to load dashboard data from the backend API.");
        }

        const [teamsPayload, devsPayload, kpisPayload, prPayload, churnPayload, deployPayload, anomaliesPayload, insightsPayload] = await Promise.all([
          teamsRes.json(),
          devsRes.json(),
          kpisRes.json(),
          prRes.json(),
          churnRes.json(),
          deployRes.json(),
          anomaliesRes.json(),
          insightsRes.json(),
        ]);

        setDashboardTeams(teamsPayload.length ? teamsPayload : TEAMS);
        setDashboardDevelopers(devsPayload.length ? devsPayload : DEVELOPERS);
        setKpisData(kpisPayload);
        setPrTrendData(prPayload || []);
        setChurnTrendData(churnPayload || []);
        setDeployTrendData(deployPayload || []);
        setAnomalyData(anomaliesPayload || []);
        setInsightData(insightsPayload || null);
      } catch (err) {
        if (controller.signal.aborted) return;
        const mockData = createMockDashboardData({ team, developer });
        setDashboardTeams(mockData.teams);
        setDashboardDevelopers(mockData.developers);
        setKpisData(mockData.kpis);
        setPrTrendData(mockData.prTrend);
        setChurnTrendData(mockData.churnTrend);
        setDeployTrendData(mockData.deployTrend);
        setAnomalyData(mockData.anomalies);
        setInsightData(mockData.insight);
        setError("Showing static mock values because the API is unavailable.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    loadDashboard();
    return () => controller.abort();
  }, [team, developer, useCustomRange, customFromDate, customToDate, rangeDays]);

  const availableDevs = useMemo(
    () => (team === "all" ? dashboardDevelopers : dashboardDevelopers.filter((d) => String(d.team_id) === String(team))),
    [team, dashboardDevelopers]
  );

  const kpis = useMemo(() => ({
    turnaroundAvg: kpisData?.pr_turnaround?.avg_hours ?? 0,
    turnaroundMedian: kpisData?.pr_turnaround?.median_hours ?? 0,
    churnAvg: kpisData?.code_churn?.avg_ratio ?? 0,
    deployPerWeek: kpisData?.deployment_frequency?.per_week ?? 0,
    sample: kpisData?.pr_turnaround?.sample_size ?? 0,
  }), [kpisData]);

  const turnaroundTrend = useMemo(() => (prTrendData || []).map((entry) => ({
    date: entry.date || entry.week || entry.period,
    value: entry.avg_hours ?? entry.value ?? 0,
  })), [prTrendData]);
  const churnTrend = useMemo(() => (churnTrendData || []).map((entry) => ({
    date: entry.date || entry.week || entry.period,
    value: entry.avg_ratio ?? entry.value ?? 0,
  })), [churnTrendData]);
  const deployTrend = useMemo(() => (deployTrendData || []).map((entry) => ({
    date: entry.week || entry.date || entry.period,
    deployments: entry.deployments || entry.count || 0,
  })), [deployTrendData]);
  const anomalies = useMemo(() => anomalyData || [], [anomalyData]);
  const insight = useMemo(() => insightData?.summary || "The live backend summary is still being generated.", [insightData]);
  const deployCount = kpisData?.deployment_frequency?.total ?? 0;

  const selectedDatePRs = [];
  const detailDevelopers = [];
  const selectedDeveloperLabel = "all users";

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
            GitLab-backed metrics · live filters · {kpis.sample.toLocaleString()} PRs in scope
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Filter style={{ width: 14, height: 14, color: COLORS.muted }} />
          <select style={selectStyle} value={team} onChange={(e) => { setTeam(e.target.value); setDeveloper("all"); }}>
            <option value="all">All teams</option>
            {dashboardTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select style={selectStyle} value={developer} onChange={(e) => setDeveloper(e.target.value)}>
            <option value="all">All developers</option>
            {availableDevs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select 
            style={selectStyle} 
            value={useCustomRange ? "custom" : rangeDays}
            onChange={(e) => {
              if (e.target.value === "custom") {
                setUseCustomRange(true);
              } else {
                setUseCustomRange(false);
                setRangeDays(Number(e.target.value));
              }
            }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
      </div>

      {/* Custom Date Range Picker */}
      {useCustomRange && (
        <div style={{
          background: COLORS.panel, border: `1px solid ${COLORS.panelBorder}`, borderRadius: 10,
          padding: "14px 16px", marginBottom: 20, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap"
        }}>
          <span style={{ color: COLORS.muted, fontSize: 12, fontWeight: 600, textTransform: "uppercase" }}>Date Range:</span>
          <input 
            type="date" 
            value={customFromDate || ""} 
            onChange={(e) => setCustomFromDate(e.target.value)}
            style={{
              background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.panelBorder}`,
              borderRadius: 6, padding: "6px 10px", fontSize: 12, outline: "none",
            }}
          />
          <span style={{ color: COLORS.muted }}>to</span>
          <input 
            type="date" 
            value={customToDate || ""} 
            onChange={(e) => setCustomToDate(e.target.value)}
            style={{
              background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.panelBorder}`,
              borderRadius: 6, padding: "6px 10px", fontSize: 12, outline: "none",
            }}
          />
          <button
            onClick={() => setUseCustomRange(false)}
            style={{
              background: COLORS.panelBorder, color: COLORS.text, border: "none",
              borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      )}

      {loading && (
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.panelBorder}`, borderRadius: 10, padding: "14px 16px", marginBottom: 20, color: COLORS.muted }}>
          Loading live metrics from the backend API...
        </div>
      )}
      {error && (
        <div style={{ background: "rgba(240,84,106,0.08)", border: `1px solid rgba(240,84,106,0.3)`, borderRadius: 10, padding: "14px 16px", marginBottom: 20, color: COLORS.text }}>
          {error}
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
          sub={`${deployCount} successful deploys`}
          accent={COLORS.accentGreen}
        />
      </div>

      {/* Trend charts */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <ChartPanel title="PR Turnaround Time (hrs, daily avg) — 48h Threshold">
          <LineChart data={turnaroundTrend}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={{ stroke: COLORS.grid }} minTickGap={30} />
            <YAxis tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="value" stroke={COLORS.accentCyan} strokeWidth={2} dot={false} />
            {/* 48-hour threshold line */}
            <ReferenceLine y={48} stroke={COLORS.accentAmber} strokeWidth={2} strokeDasharray="5,5" label={{ value: "48h Threshold", position: "right", fill: COLORS.accentAmber, fontSize: 10 }} />
            {anomalies.filter((a) => a.type === "slow_pr").map((a, i) => {
              const pt = turnaroundTrend.find((t) => t.date === a.date);
              return pt ? <ReferenceDot key={i} x={pt.date} y={pt.value} r={4} fill={COLORS.accentRed} stroke="none" /> : null;
            })}
          </LineChart>
        </ChartPanel>

        <ChartPanel title="Code Churn Trend (daily avg)">
          <AreaChart data={churnTrend}>
            <defs>
              <linearGradient id="churnFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.accentAmber} stopOpacity={0.4} />
                <stop offset="100%" stopColor={COLORS.accentAmber} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: COLORS.muted, fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: COLORS.grid }}
              minTickGap={30}
            />
            <YAxis
              tick={{ fill: COLORS.muted, fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              domain={[0, 0.5]}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v) => `${(v * 100).toFixed(1)}% churn`}
              labelFormatter={(label) => `Date: ${label}`}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={COLORS.accentAmber}
              strokeWidth={2.5}
              fill="url(#churnFill)"
              activeDot={{ r: 5, fill: COLORS.accentAmber, stroke: COLORS.bg, strokeWidth: 2 }}
            />
          </AreaChart>
        </ChartPanel>

        <ChartPanel title="Deployment Frequency (weekly)">
          <BarChart data={deployTrend}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={{ stroke: COLORS.grid }} />
            <YAxis tick={{ fill: COLORS.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value) => [`${value} deploys`, "deployments"]}
              labelFormatter={(label) => `Week: ${label}`}
            />
            <Bar dataKey="deployments" name="deployments" fill={COLORS.accentGreen} radius={[4,4,0,0]} />
          </BarChart>
        </ChartPanel>
      </div>

      <div style={{ color: COLORS.muted, fontSize: 11, marginTop: 18, textAlign: "center" }}>
        Live data from the backend API · the UI is now connected to /api/v1/* endpoints.
      </div>

      <div style={{
        background: COLORS.panel, border: `1px solid ${COLORS.panelBorder}`, borderRadius: 10,
        padding: "16px 18px", marginBottom: 20, marginTop: 20,
      }}>
        <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>AI-Generated Insight Summary</div>
        <div style={{ color: COLORS.text, fontSize: 13, lineHeight: 1.6 }}>{insight}</div>
      </div>
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
    </div>
  );
}
