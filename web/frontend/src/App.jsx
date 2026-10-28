import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api, fmtDuration, toCsv, ymd, weekRange, monthRange } from "./api.js";
import DayChart from "./components/DayChart.jsx";
import Heatmap from "./components/Heatmap.jsx";
import SettingsModal from "./components/SettingsModal.jsx";
import LogsModal from "./components/LogsModal.jsx";
import Timer from "./components/Timer.jsx";
import EntriesTable from "./components/EntriesTable.jsx";
import StatsPage from "./components/StatsPage.jsx";
import Kpi from "./components/Kpi.jsx";

// Categorical project palettes. Canvas can't read CSS vars, so these mirror
// Graphite's tokens/colors.css: --chart-1, -2, -3, --input (gray), --chart-4,
// --chart-5, --destructive. Keep in sync if the tokens change.
const SERIES_DARK = ["#9084DA", "#5596DC", "#34C77B", "#5D6872", "#EACC56", "#DA7BB3", "#F25555"];
const SERIES_LIGHT = ["#6656C8", "#2F7FC9", "#13703F", "#8B949E", "#B5772A", "#C25A7F", "#C93030"];

export default function App() {
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  // Stats is its own page at /stats (the server serves index.html for any path).
  const page = location.pathname.startsWith("/stats") ? "stats" : "tracker";

  const [view, setView] = useState("week"); // 'week' | 'month' | 'all'
  const [anchor, setAnchor] = useState(new Date());

  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState({ byProject: [], totalMs: 0 });
  const [stats, setStats] = useState(null);
  const [jira, setJira] = useState({ jiraBaseUrl: null, jiraEnrich: false });
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  // Stamp the attribute before re-render so charts read the new mode's tokens.
  const chooseTheme = (t) => { localStorage.setItem("theme", t); document.documentElement.setAttribute("data-theme", t); setTheme(t); };
  const SERIES = theme === "light" ? SERIES_LIGHT : SERIES_DARK;
  const [error, setError] = useState(null);

  const range = useMemo(() => {
    if (view === "week") return weekRange(anchor);
    if (view === "month") return monthRange(anchor);
    return { from: null, to: null };
  }, [view, anchor]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const params = { from: range.from, to: range.to };
      const [e, s, st] = await Promise.all([
        api.entries(params),
        api.summary(params),
        api.stats(params),
      ]);
      setEntries(e);
      setSummary(s);
      setStats(st);
    } catch (err) {
      setError(err.message);
    }
  }, [range]);

  useEffect(() => {
    api.settings().then(setSettings).catch((e) => setError(e.message));
    api.config().then(setJira).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveSettings = async (next) => {
    const saved = await api.saveSettings(next);
    setSettings(saved);
    setShowSettings(false);
    load();
  };

  const step = (dir) => {
    const d = new Date(anchor);
    if (view === "week") d.setDate(d.getDate() + dir * 7);
    else if (view === "month") d.setMonth(d.getMonth() + dir);
    setAnchor(d);
  };

  const rangeLabel = useMemo(() => {
    if (view === "all") return "All time";
    if (view === "month")
      return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const { from, to } = range;
    const f = new Date(from), t = new Date(to);
    const opts = { day: "numeric", month: "short" };
    return `${f.toLocaleDateString(undefined, opts)} – ${t.toLocaleDateString(undefined, { ...opts, year: "numeric" })}`;
  }, [view, anchor, range]);

  const exportCsv = () => {
    const blob = new Blob([toCsv(entries)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `time-${range.from || "all"}_${range.to || ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Stable project -> color map, shared by the chart and the breakdown.
  const colorMap = useMemo(() => {
    const m = {};
    summary.byProject.forEach((p, i) => { m[p.project] = SERIES[i % SERIES.length]; });
    return m;
  }, [summary, theme]);
  const colorFor = (p) => colorMap[p] || SERIES[3];
  const projectOf = (ticket) => (ticket ? ticket.split("-")[0] : "(no ticket)");

  // Daily series for the chart (week/month views only), stacked by project.
  const daily = useMemo(() => {
    if (!settings || view === "all" || !range.from) return null;
    const work = new Set(settings.workDays);
    const dailyTarget = work.size ? settings.targetHoursPerWeek / work.size : 0;

    const byProj = {}; // project -> { day: ms }
    for (const e of entries) {
      const p = projectOf(e.ticket);
      (byProj[p] ||= {});
      byProj[p][e.day] = (byProj[p][e.day] || 0) + e.duration_ms;
    }

    const days = [];
    const to = new Date(range.to);
    for (let d = new Date(range.from); d <= to; d.setDate(d.getDate() + 1)) {
      if (work.has(d.getDay())) days.push(new Date(d)); // only selected work days
    }

    const labels = days.map((d) =>
      view === "week" ? d.toLocaleDateString(undefined, { weekday: "short" }) : String(d.getDate())
    );
    const datasets = Object.keys(byProj).map((p) => ({
      label: p,
      color: colorFor(p),
      data: days.map((d) => Number(((byProj[p][ymd(d)] || 0) / 3600000).toFixed(2))),
    }));
    const target = days.map((d) => (work.has(d.getDay()) ? dailyTarget : null));
    return { labels, datasets, target };
  }, [entries, settings, view, range, colorMap]);

  const maxProject = Math.max(1, ...summary.byProject.map((p) => p.ms));

  // Show a "jump to now" button when the selected range isn't the current one.
  const todayStr = ymd(new Date());
  const onCurrent = view === "all" || (range.from <= todayStr && todayStr <= range.to);

  if (!settings) return <div className="wrap"><p className="muted">Loading…</p></div>;

  return (
    <div className="wrap">
      <header>
        {page === "stats" ? (
          <nav aria-label="Breadcrumb" className="breadcrumb">
            <a href="/">Time tracker</a>
            <span aria-hidden="true">/</span>
            <h1 aria-current="page">Stats</h1>
          </nav>
        ) : (
        <div className="nav">
          <button className="icon" disabled={view === "all"} onClick={() => step(-1)} aria-label="Previous">‹</button>
          <div>
            <div className="range-mode">
              <select value={view} onChange={(e) => { setView(e.target.value); setAnchor(new Date()); }}>
                <option value="week">This week</option>
                <option value="month">This month</option>
                <option value="all">All time</option>
              </select>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{rangeLabel}</div>
          </div>
          <button className="icon" disabled={view === "all"} onClick={() => step(1)} aria-label="Next">›</button>
          {!onCurrent && (
            <button className="link" onClick={() => setAnchor(new Date())}>
              {view === "month" ? "This month" : "This week"}
            </button>
          )}
        </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          {page === "stats" ? <a className="btn" href="/">‹ Tracker</a> : <a className="btn" href="/stats">Stats</a>}
          <div className="theme-toggle" role="group" aria-label="Theme">
            <button className={theme === "light" ? "on" : ""} onClick={() => chooseTheme("light")}>Light</button>
            <button className={theme === "dark" ? "on" : ""} onClick={() => chooseTheme("dark")}>Dark</button>
          </div>
          <button onClick={() => setShowSettings(true)}>Settings</button>
          {page === "tracker" && <button onClick={exportCsv}>Export CSV</button>}
        </div>
      </header>

      {page === "stats" ? <StatsPage settings={settings} series={SERIES} jira={jira} /> : <>
      {error && <div className="error">Error: {error}</div>}

      <Timer onChange={load} />

      {stats && (
        <div className="kpis">
          <Kpi label={view === "all" ? "Total" : "Selected range"} value={fmtDuration(stats.rangeTotalMs)} />
          <Kpi
            label="Target"
            value={stats.targetPct == null ? "—" : `${stats.targetPct}%`}
            sub={stats.expectedRangeMs ? `of ${fmtDuration(stats.expectedRangeMs)}` : "no target in range"}
          />
          <Kpi label="Daily average" value={fmtDuration(stats.dailyAvgMs)} sub={`across ${stats.daysWithWork} day${stats.daysWithWork === 1 ? "" : "s"}`} />
          <Kpi
            label="Flex balance"
            value={fmtDuration(stats.flexBalanceMs)}
            sub={stats.flexBalanceMs >= 0 ? "banked" : "behind target"}
            tone={stats.flexBalanceMs >= 0 ? "success" : "danger"}
          />
        </div>
      )}

      {daily && (
        <section className="card">
          <div className="row-between" style={{ marginBottom: 8 }}>
            <h2>Hours per day</h2>
            <div className="legend">
              {daily.datasets.map((ds) => (
                <span key={ds.label}><span className="swatch" style={{ background: ds.color }} />{ds.label}</span>
              ))}
              <span><span className="dash" />Target</span>
            </div>
          </div>
          <DayChart labels={daily.labels} datasets={daily.datasets} target={daily.target} />
        </section>
      )}

      {summary.byProject.length > 0 && (
        <section className="card">
          <h2>Time by project</h2>
          <div className="proj-list">
            {summary.byProject.map((p, i) => (
              <div key={p.project}>
                <div className="proj-head">
                  <span>{p.project}</span>
                  <span className="muted">
                    {fmtDuration(p.ms)} · {summary.totalMs ? Math.round((p.ms / summary.totalMs) * 100) : 0}%
                  </span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(p.ms / maxProject) * 100}%`, background: colorFor(p.project) }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <ManualForm settings={settings} onAdded={load} />

      <section className="card">
        <h2>Entries</h2>
        {entries.length === 0 ? (
          <p className="muted">No entries in this range. Commit some code, run the timer, or add a manual entry.</p>
        ) : (
          <EntriesTable entries={entries} pageSize={settings.pageSize || 10} jira={jira} onChange={load} />
        )}
      </section>

      <Heatmap />
      </>}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          onViewLogs={() => setShowLogs(true)}
        />
      )}
      {showLogs && <LogsModal onClose={() => setShowLogs(false)} />}
    </div>
  );
}


function ManualForm({ settings, onAdded }) {
  const today = ymd(new Date());
  const [mode, setMode] = useState("single"); // 'single' | 'range'
  const [form, setForm] = useState({ day: today, from: today, to: today, ticket: "", description: "", hours: "", minutes: "" });
  const [workdaysOnly, setWorkdaysOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const workSet = new Set(settings.workDays || []);
  const dailyTargetMin = settings.workDays?.length
    ? Math.round((settings.targetHoursPerWeek / settings.workDays.length) * 60)
    : 0;

  const buildDays = (workdaysFilter) => {
    if (mode === "single") return form.day ? [form.day] : [];
    const out = [];
    const to = new Date(form.to);
    for (let d = new Date(form.from); d <= to; d.setDate(d.getDate() + 1)) {
      if (workdaysFilter && !workSet.has(d.getDay())) continue;
      out.push(ymd(d));
    }
    return out;
  };

  const reset = () => setForm({ day: today, from: today, to: today, ticket: "", description: "", hours: "", minutes: "" });

  const post = async (days, minutes, ticket, description) => {
    setBusy(true);
    setErr(null);
    try {
      if (!days.length) throw new Error("No days selected");
      if (!(minutes > 0)) throw new Error("Enter a time greater than 0");
      await api.bulkAdd({ days, ticket, description, minutes });
      reset();
      onAdded();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    const minutes = (Number(form.hours) || 0) * 60 + (Number(form.minutes) || 0);
    post(buildDays(workdaysOnly), minutes, form.ticket, form.description);
  };

  // Day-off bookings always skip weekends/non-workdays; fill the average day.
  // Labels come from Settings (server fills defaults).
  const quickDays = [
    ["Holiday", settings.holidayLabel || "URLAUB"],
    ["Unisys day", settings.unisysLabel || "UNISYS"],
    ["Sick", settings.sickLabel || "KRANK"],
    ["Public holiday", settings.publicHolidayLabel || "FEIERTAG"],
  ];
  const addQuick = (e) => {
    const ticket = e.target.value;
    e.target.value = "";
    if (ticket) post(buildDays(true), dailyTargetMin, ticket, "");
  };

  const dayCount = buildDays(workdaysOnly).length;

  return (
    <form className="card manual" onSubmit={submit}>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <h2>Add manual entry</h2>
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: 150 }}>
          <option value="single">Single day</option>
          <option value="range">Date range</option>
        </select>
      </div>
      <div className="fields">
        {mode === "single" ? (
          <label>Date<input type="date" value={form.day} onChange={set("day")} required /></label>
        ) : (
          <>
            <label>From<input type="date" value={form.from} onChange={set("from")} required /></label>
            <label>To<input type="date" value={form.to} onChange={set("to")} required /></label>
            <label className="check"><input type="checkbox" checked={workdaysOnly} onChange={(e) => setWorkdaysOnly(e.target.checked)} />Workdays only</label>
          </>
        )}
        <label>Ticket<input placeholder="PROJ-123" value={form.ticket} onChange={set("ticket")} /></label>
        <label className="grow">Description<input placeholder="What did you work on?" value={form.description} onChange={set("description")} /></label>
        <label>Hours<input type="number" min="0" step="1" value={form.hours} onChange={set("hours")} onWheel={(e) => e.target.blur()} style={{ width: 70 }} /></label>
        <label>Min<input type="number" min="0" max="59" step="1" value={form.minutes} onChange={set("minutes")} onWheel={(e) => e.target.blur()} style={{ width: 70 }} /></label>
        <button className="primary" disabled={busy} type="submit">{busy ? "Adding…" : mode === "range" ? "Add to days" : "Add"}</button>
        <select defaultValue="" disabled={busy || !dailyTargetMin} onChange={addQuick} title="Book a full day (daily target)" aria-label="Book a day off" style={{ width: 150 }}>
          <option value="" disabled>Book day…</option>
          {quickDays.map(([label, ticket]) => <option key={label} value={ticket}>{label}</option>)}
        </select>
      </div>
      {mode === "range" && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{dayCount} day{dayCount === 1 ? "" : "s"} will be booked{workdaysOnly ? " (workdays only)" : ""}.</div>}
      {err && <div className="error">{err}</div>}
    </form>
  );
}
