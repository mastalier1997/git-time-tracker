import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDuration, toCsv, ymd, monthRange } from "../api.js";
import DayChart from "./DayChart.jsx";
import PieChart from "./PieChart.jsx";
import EntriesTable from "./EntriesTable.jsx";
import Kpi from "./Kpi.jsx";

const H = 3600000;
const MONTHS = [...Array(12)].map((_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: "short" }));
const projectOf = (t) => (t ? t.split("-")[0] : "(no ticket)");
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

// Expected time for [from, to]: work days from the first tracked day up to
// today x daily target (same window as the tracker's flex balance).
function expectedMs(from, to, settings, firstDay) {
  const work = new Set(settings.workDays);
  const daily = work.size ? (settings.targetHoursPerWeek / work.size) * H : 0;
  const today = ymd(new Date());
  const start = firstDay && firstDay > from ? firstDay : from;
  const end = to < today ? to : today;
  let n = 0;
  for (let d = parseYmd(start); ymd(d) <= end; d.setDate(d.getDate() + 1)) if (work.has(d.getDay())) n++;
  return n * daily;
}

function periodRange(p) {
  if (p.gran === "month") return monthRange(new Date(p.year, p.month, 1));
  if (p.gran === "quarter") return { from: ymd(new Date(p.year, p.quarter * 3, 1)), to: ymd(new Date(p.year, p.quarter * 3 + 3, 0)) };
  if (p.gran === "year") return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
  return { from: p.from, to: p.to };
}

const sumBy = (list, keyFn) => {
  const m = {};
  for (const e of list) { const k = keyFn(e); m[k] = (m[k] || 0) + e.duration_ms; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};
const distinctDays = (list) => new Set(list.map((e) => e.day)).size;

// ponytail: loads every entry once and aggregates in the browser; fine for
// thousands of rows. Move aggregation to an /api endpoint if it gets slow.
export default function StatsPage({ settings, series, jira }) {
  const now = new Date();
  const [all, setAll] = useState([]);
  const [error, setError] = useState(null);
  const [p, setP] = useState({ gran: "month", year: now.getFullYear(), month: now.getMonth(), quarter: Math.floor(now.getMonth() / 3), from: ymd(now), to: ymd(now) });
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const [hidden, setHidden] = useState(() => new Set());
  const [chartType, setChartType] = useState(() => { try { return localStorage.getItem("statsChart") || "bar"; } catch { return "bar"; } });
  const chooseChart = (t) => { try { localStorage.setItem("statsChart", t); } catch {} setChartType(t); };
  const set = (k) => (e) => setP({ ...p, [k]: e.target.type === "date" || k === "gran" ? e.target.value : Number(e.target.value) });

  const load = useCallback(() => api.entries().then(setAll).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  // Holiday, sick and public holiday count as days off; Unisys day is work.
  const kinds = [
    ["Holiday", settings.holidayLabel || "URLAUB"],
    ["Sick", settings.sickLabel || "KRANK"],
    ["Public holiday", settings.publicHolidayLabel || "FEIERTAG"],
  ];
  const offSet = new Set(kinds.map((k) => k[1]));
  const unisys = settings.unisysLabel || "UNISYS";

  const projects = useMemo(() => sumBy(all, (e) => projectOf(e.ticket)).map(([k]) => k), [all]);
  const firstDay = useMemo(() => all.reduce((m, e) => (!m || e.day < m ? e.day : m), null), [all]);
  const years = useMemo(() => [...new Set([now.getFullYear(), ...all.map((e) => Number(e.day.slice(0, 4)))])].sort((a, b) => b - a), [all]);

  const base = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((e) =>
      (!source || e.source === source) &&
      !hidden.has(projectOf(e.ticket)) &&
      (!needle || (e.ticket || "").toLowerCase().includes(needle) || (e.description || "").toLowerCase().includes(needle))
    );
  }, [all, source, q, hidden]);

  const range = periodRange(p);
  const inPeriod = useMemo(() => base.filter((e) => e.day >= range.from && e.day <= range.to), [base, range.from, range.to]);
  // Memoized so the chart isn't rebuilt on unrelated renders.
  const yearEntries = useMemo(() => base.filter((e) => e.day.startsWith(String(p.year))), [base, p.year]);

  // Chart buckets: top 5 projects of the year, "Other", and "Days off".
  const { bucketOf, colorOf } = useMemo(() => {
    const top = sumBy(yearEntries.filter((e) => !offSet.has(e.ticket)), (e) => projectOf(e.ticket)).slice(0, 5).map(([k]) => k);
    const colors = Object.fromEntries(top.map((k, i) => [k, series[[0, 1, 2, 4, 6][i]]]));
    colors.Other = series[5];
    colors["Days off"] = series[3];
    const bucketOf = (e) => (offSet.has(e.ticket) ? "Days off" : top.includes(projectOf(e.ticket)) ? projectOf(e.ticket) : "Other");
    return { bucketOf, colorOf: (b) => colors[b] };
  }, [yearEntries, series, settings]);

  const chart = useMemo(() => {
    const isCurrent = p.year === now.getFullYear();
    const months = [...Array(isCurrent ? now.getMonth() + 1 : 12).keys()];
    const byBucket = {};
    for (const e of yearEntries) {
      const b = bucketOf(e);
      (byBucket[b] ||= Array(months.length).fill(0))[Number(e.day.slice(5, 7)) - 1] += e.duration_ms / H;
    }
    return {
      labels: months.map((m) => MONTHS[m]),
      datasets: Object.entries(byBucket).map(([b, data]) => ({ label: b, color: colorOf(b), data: data.slice(0, months.length).map((v) => Number(v.toFixed(2))) })),
      target: months.map((m) => { const r = monthRange(new Date(p.year, m, 1)); return Number((expectedMs(r.from, r.to, settings, firstDay) / H).toFixed(2)); }),
    };
  }, [yearEntries, p.year, settings, bucketOf, colorOf, firstDay]);
  // Pie: the selected period split into the same buckets as the bars.
  const slices = useMemo(() => {
    const m = {};
    for (const e of inPeriod) { const b = bucketOf(e); m[b] = (m[b] || 0) + e.duration_ms / H; }
    return Object.entries(m).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, color: colorOf(label) }));
  }, [inPeriod, bucketOf, colorOf]);
  const openMonth = useCallback((i) => setP((cur) => ({ ...cur, gran: "month", month: i })), []);

  const tracked = inPeriod.reduce((a, e) => a + e.duration_ms, 0);
  const target = expectedMs(range.from, range.to, settings, firstDay);
  const balance = tracked - target;
  const daysOff = distinctDays(inPeriod.filter((e) => offSet.has(e.ticket)));
  const byProject = sumBy(inPeriod, (e) => projectOf(e.ticket));
  const maxProject = byProject[0]?.[1] || 1;
  const topTickets = sumBy(inPeriod.filter((e) => e.ticket), (e) => e.ticket).slice(0, 5);

  // Day-off totals use the whole year, ignoring the project/text filters.
  const yearAll = all.filter((e) => e.day.startsWith(String(p.year)));
  const kindStats = [...kinds, ["Unisys day", unisys]].map(([label, ticket]) => {
    const list = yearAll.filter((e) => e.ticket === ticket);
    return { label, ticket, days: distinctDays(list), ms: list.reduce((a, e) => a + e.duration_ms, 0) };
  });
  const allowance = settings.holidayDaysPerYear ?? 30;

  const toggle = (k) => setHidden((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const periodLabel = p.gran === "month" ? `${MONTHS[p.month]} ${p.year}` : p.gran === "quarter" ? `Q${p.quarter + 1} ${p.year}` : p.gran === "year" ? String(p.year) : `${range.from} – ${range.to}`;
  const exportCsv = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toCsv(inPeriod)], { type: "text/csv" }));
    a.download = `time-${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      {error && <div className="error">Error: {error}</div>}

      <div className="filters">
        <select value={p.gran} onChange={set("gran")}>
          <option value="month">Month</option>
          <option value="quarter">Quarter</option>
          <option value="year">Year</option>
          <option value="custom">Custom range</option>
        </select>
        {p.gran !== "custom" && (
          <select value={p.year} onChange={set("year")}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
        )}
        {p.gran === "month" && (
          <select value={p.month} onChange={set("month")}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
        )}
        {p.gran === "quarter" && (
          <select value={p.quarter} onChange={set("quarter")}>{[0, 1, 2, 3].map((i) => <option key={i} value={i}>Q{i + 1}</option>)}</select>
        )}
        {p.gran === "custom" && (
          <>
            <input type="date" value={p.from} onChange={set("from")} />
            <input type="date" value={p.to} onChange={set("to")} />
          </>
        )}
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Source: all</option>
          <option value="git">Git commits</option>
          <option value="manual">Manual</option>
        </select>
        <input placeholder="Ticket or text" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
      </div>

      <div className="filters">
        {projects.map((k) => (
          <button key={k} type="button" className={`day-chip ${hidden.has(k) ? "" : "on"}`} onClick={() => toggle(k)}>{k}</button>
        ))}
        {hidden.size > 0 && <button className="link" onClick={() => setHidden(new Set())}>Show all</button>}
      </div>

      <div className="kpis">
        <Kpi label={`Tracked · ${periodLabel}`} value={fmtDuration(tracked)} sub={`${inPeriod.length} entr${inPeriod.length === 1 ? "y" : "ies"}`} />
        <Kpi label="Target" value={target ? fmtDuration(target) : "—"} sub={target ? `${Math.round((tracked / target) * 100)}% reached` : "no work days yet"} />
        <Kpi label="Balance" value={fmtDuration(balance)} sub={balance >= 0 ? "ahead of target" : "behind target"} tone={balance >= 0 ? "success" : "danger"} />
        <Kpi label="Days off" value={String(daysOff)} sub="holiday, sick, public holiday" />
      </div>

      <section className="card">
        <div className="row-between" style={{ marginBottom: 8, flexWrap: "wrap" }}>
          <h2>{chartType === "pie" ? `Share by project · ${periodLabel}` : `Hours per month · ${p.year}`}</h2>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div className="legend">
              {(chartType === "pie" ? slices : chart.datasets).map((ds) => (
                <span key={ds.label}><span className="swatch" style={{ background: ds.color }} />{ds.label}</span>
              ))}
              {chartType === "bar" && <span><span className="dash" />Target</span>}
            </div>
            <div className="theme-toggle" role="group" aria-label="Chart type">
              <button className={chartType === "bar" ? "on" : ""} onClick={() => chooseChart("bar")}>Bar</button>
              <button className={chartType === "pie" ? "on" : ""} onClick={() => chooseChart("pie")}>Pie</button>
            </div>
          </div>
        </div>
        {chartType === "pie" ? (
          slices.length ? <PieChart slices={slices} /> : <p className="muted">No entries match these filters.</p>
        ) : (
          <>
            <DayChart labels={chart.labels} datasets={chart.datasets} target={chart.target} onBarClick={openMonth} />
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>Click a bar to open that month.</p>
          </>
        )}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
        <section className="card">
          <h2>By project · {periodLabel}</h2>
          {byProject.length === 0 ? <p className="muted">No entries match these filters.</p> : (
            <div className="proj-list">
              {byProject.map(([k, ms]) => (
                <div key={k}>
                  <div className="proj-head">
                    <span>{k}</span>
                    <span className="muted">{fmtDuration(ms)} · {tracked ? Math.round((ms / tracked) * 100) : 0}%</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(ms / maxProject) * 100}%`, background: colorOf(offSet.has(k) ? "Days off" : colorOf(k) ? k : "Other") }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Days off · {p.year}</h2>
          <div className="proj-list">
            {kindStats.map((s, i) => (
              <div key={s.ticket}>
                <div className="proj-head">
                  <span>{s.label} <span className="muted">({s.ticket})</span></span>
                  <span className="muted">
                    {i === 0 ? `${s.days} of ${allowance} days` : `${s.days} day${s.days === 1 ? "" : "s"} · ${fmtDuration(s.ms)}`}
                  </span>
                </div>
                {i === 0 && (
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${Math.min(100, allowance ? (s.days / allowance) * 100 : 0)}%`, background: series[0] }} />
                  </div>
                )}
              </div>
            ))}
          </div>

          <h2 style={{ marginTop: 20 }}>Top tickets · {periodLabel}</h2>
          {topTickets.length === 0 ? <p className="muted">No tickets in this period.</p> : (
            <div className="proj-list" style={{ gap: 6 }}>
              {topTickets.map(([t, ms]) => (
                <div key={t} className="proj-head" style={{ margin: 0 }}>
                  <span>{t}</span><span className="muted">{fmtDuration(ms)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="row-between" style={{ marginBottom: 8 }}>
          <h2>Matching entries · {periodLabel}</h2>
          <button onClick={exportCsv} disabled={!inPeriod.length}>Export CSV</button>
        </div>
        {inPeriod.length === 0 ? <p className="muted">No entries match these filters.</p> : (
          <EntriesTable entries={inPeriod} pageSize={settings.pageSize || 10} jira={jira} onChange={load} />
        )}
      </section>
    </>
  );
}
