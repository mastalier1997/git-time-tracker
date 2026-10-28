"use strict";

/**
 * time-tracker backend.
 *
 *  - Owns a SQLite database (the single source of truth for the UI).
 *  - Imports git-sourced entries from the host's data/entries.json "inbox"
 *    (written by the git hook), deduped by id / commit hash. Edits made in the
 *    UI are preserved because import uses INSERT OR IGNORE.
 *  - Manual entries, a start/stop timer, settings (work week + targets), stats
 *    (incl. a running flex-time ledger) and a year heatmap.
 *  - Serves the built React frontend as static files. One process / container.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || "/data";
const PORT = process.env.PORT || 8787;
const ENTRIES_JSON = path.join(DATA_DIR, "entries.json");
const DB_FILE = path.join(DATA_DIR, "tracker.db");
const LOG_FILE = path.join(DATA_DIR, "app.log");

// Optional Jira (read-only). Configured via env; never required.
const JIRA_BASE = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
const JIRA_TOKEN = process.env.JIRA_TOKEN || "";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Shared append-only log (data/app.log). The host Outlook importer writes to the
// same file, so its errors show up here too. Kept bounded on read.
function logLine(source, level, msg) {
  const line = `${new Date().toISOString()} [${source}] ${level} ${String(msg).replace(/\s+/g, " ").trim()}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,          -- 'git' | 'manual'
    ticket       TEXT,
    description  TEXT,
    day          TEXT NOT NULL,          -- YYYY-MM-DD
    start        TEXT,
    end          TEXT,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    repo         TEXT,
    commit_hash  TEXT UNIQUE,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const insertEntry = db.prepare(`
  INSERT OR IGNORE INTO entries
    (id, source, ticket, description, day, start, end, duration_ms, repo, commit_hash, created_at)
  VALUES
    (@id, @source, @ticket, @description, @day, @start, @end, @duration_ms, @repo, @commit_hash, @created_at)
`);

// ---- key/value helpers (settings, timer) ----------------------------------

// Day-off labels are the tickets booked by the "Book day…" quick select.
const LABEL_KEYS = ["holidayLabel", "unisysLabel", "sickLabel", "publicHolidayLabel"];
const DEFAULT_SETTINGS = {
  workDays: [1, 2, 3, 4, 5], targetHoursPerWeek: 38.5, pageSize: 10, holidayDaysPerYear: 30,
  holidayLabel: "URLAUB", unisysLabel: "UNISYS", sickLabel: "KRANK", publicHolidayLabel: "FEIERTAG",
};

// Project = the prefix of a ticket before the first '-' (PM-2393 -> PM).
const PROJECT_EXPR =
  "CASE WHEN instr(ticket,'-')>0 THEN substr(ticket,1,instr(ticket,'-')-1) ELSE ticket END";

function kvGet(key, fallback) {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}
function kvSet(key, value) {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}
function getSettings() {
  return { ...DEFAULT_SETTINGS, ...kvGet("settings", {}) };
}

// ---------------------------------------------------------------------------
// Date helpers (all dates are local YYYY-MM-DD strings)
// ---------------------------------------------------------------------------

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function dayOf(iso) {
  return (iso || new Date().toISOString()).slice(0, 10);
}
function eachDay(fromStr, toStr, fn) {
  const to = parseYmd(toStr);
  for (let d = parseYmd(fromStr); d <= to; d.setDate(d.getDate() + 1)) fn(new Date(d));
}

// ---------------------------------------------------------------------------
// Import from the host's entries.json "inbox"
// ---------------------------------------------------------------------------

function importFromJson() {
  if (!fs.existsSync(ENTRIES_JSON)) return;
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(ENTRIES_JSON, "utf8"));
  } catch {
    return; // file mid-write or malformed; retry next time
  }
  const deleted = new Set(kvGet("deleted", []));
  const tx = db.transaction((items) => {
    for (const e of items) {
      if (!e || typeof e.id !== "string") continue; // skip malformed rows
      if (deleted.has(e.id) || (e.commit && deleted.has(e.commit))) continue;
      insertEntry.run({
        id: e.id,
        source: e.type === "git" ? "git" : "manual",
        ticket: e.ticket || null,
        description: e.description || "",
        day: dayOf(e.end || e.start),
        start: e.start || null,
        end: e.end || null,
        duration_ms: e.durationMs || 0,
        repo: e.repo || null,
        commit_hash: e.commit || null,
        created_at: e.end || e.start || new Date().toISOString(),
      });
    }
  });
  tx(rows);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

function entryWhere(query) {
  const clauses = [];
  const params = {};
  if (query.project) {
    clauses.push(`${PROJECT_EXPR} = @project`);
    params.project = query.project;
  }
  if (query.source) {
    clauses.push("source = @source");
    params.source = query.source;
  }
  if (query.from) {
    clauses.push("day >= @from");
    params.from = query.from;
  }
  if (query.to) {
    clauses.push("day <= @to");
    params.to = query.to;
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

// --- settings --------------------------------------------------------------

app.get("/api/settings", (req, res) => res.json(getSettings()));

app.put("/api/settings", (req, res) => {
  const cur = getSettings();
  const next = { ...cur };
  if (Array.isArray(req.body.workDays)) {
    next.workDays = req.body.workDays.map(Number).filter((n) => n >= 0 && n <= 6);
  }
  if (Number.isFinite(Number(req.body.targetHoursPerWeek))) {
    next.targetHoursPerWeek = Math.max(0, Number(req.body.targetHoursPerWeek));
  }
  if (Number.isInteger(Number(req.body.pageSize)) && Number(req.body.pageSize) > 0) {
    next.pageSize = Number(req.body.pageSize);
  }
  if (Number.isFinite(Number(req.body.holidayDaysPerYear))) {
    next.holidayDaysPerYear = Math.max(0, Math.round(Number(req.body.holidayDaysPerYear)));
  }
  for (const k of LABEL_KEYS) {
    if (typeof req.body[k] === "string" && req.body[k].trim()) next[k] = req.body[k].trim();
  }
  kvSet("settings", next);
  res.json(next);
});

// --- entries ---------------------------------------------------------------

app.get("/api/entries", (req, res) => {
  importFromJson();
  const { where, params } = entryWhere(req.query);
  const rows = db
    .prepare(`SELECT * FROM entries ${where} ORDER BY day DESC, created_at DESC`)
    .all(params);
  res.json(rows);
});

app.post("/api/entries", (req, res) => {
  const { day, ticket, description, minutes } = req.body || {};
  const mins = Number(minutes);
  if (!day || !Number.isFinite(mins) || mins <= 0) {
    return res.status(400).json({ error: "day and a positive minutes value are required" });
  }
  const id = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  insertEntry.run({
    id,
    source: "manual",
    ticket: ticket ? String(ticket).trim() : null,
    description: description ? String(description).trim() : "",
    day,
    start: null,
    end: null,
    duration_ms: Math.round(mins * 60000),
    repo: null,
    commit_hash: null,
    created_at: new Date().toISOString(),
  });
  res.status(201).json(db.prepare("SELECT * FROM entries WHERE id = ?").get(id));
});

// Edit an entry (works for git and manual). Only these fields are editable.
app.patch("/api/entries/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const next = {
    ticket: "ticket" in req.body ? (req.body.ticket ? String(req.body.ticket).trim() : null) : row.ticket,
    description: "description" in req.body ? String(req.body.description || "") : row.description,
    day: "day" in req.body && req.body.day ? String(req.body.day) : row.day,
    duration_ms:
      "minutes" in req.body && Number.isFinite(Number(req.body.minutes))
        ? Math.max(0, Math.round(Number(req.body.minutes) * 60000))
        : row.duration_ms,
  };
  db.prepare("UPDATE entries SET ticket=@ticket, description=@description, day=@day, duration_ms=@duration_ms WHERE id=@id")
    .run({ ...next, id: req.params.id });
  res.json(db.prepare("SELECT * FROM entries WHERE id = ?").get(req.params.id));
});

app.delete("/api/entries/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  // Remember the delete so the git-hook inbox can't silently re-import it.
  const deleted = new Set(kvGet("deleted", []));
  deleted.add(row.id);
  if (row.commit_hash) deleted.add(row.commit_hash);
  kvSet("deleted", [...deleted]);
  db.prepare("DELETE FROM entries WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Bulk manual add: one entry per day. Body { days:[], ticket, description, minutes }.
app.post("/api/entries/bulk", (req, res) => {
  const { days, ticket, description, minutes } = req.body || {};
  const mins = Number(minutes);
  if (!Array.isArray(days) || days.length === 0 || !Number.isFinite(mins) || mins <= 0) {
    return res.status(400).json({ error: "days[] and a positive minutes value are required" });
  }
  const now = new Date().toISOString();
  const tx = db.transaction((list) => {
    for (const day of list) {
      insertEntry.run({
        id: "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        source: "manual",
        ticket: ticket ? String(ticket).trim() : null,
        description: description ? String(description).trim() : "",
        day: String(day),
        start: null,
        end: null,
        duration_ms: Math.round(mins * 60000),
        repo: null,
        commit_hash: null,
        created_at: now,
      });
    }
  });
  tx(days);
  res.status(201).json({ added: days.length });
});

// Bulk delete. Body { ids:[] }. Records deletes so the git inbox can't re-import.
app.post("/api/entries/bulk-delete", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length === 0) return res.status(400).json({ error: "ids[] is required" });
  const deleted = new Set(kvGet("deleted", []));
  let n = 0;
  const tx = db.transaction((list) => {
    const del = db.prepare("DELETE FROM entries WHERE id = ?");
    for (const id of list) {
      const row = db.prepare("SELECT commit_hash FROM entries WHERE id = ?").get(id);
      if (!row) continue;
      deleted.add(id);
      if (row.commit_hash) deleted.add(row.commit_hash);
      n += del.run(id).changes;
    }
  });
  tx(ids);
  kvSet("deleted", [...deleted]);
  res.json({ deleted: n });
});

// Bulk edit. Body { patches: [{ id, ticket?, description?, minutes? }] }.
// Same per-field semantics as PATCH /api/entries/:id; only provided fields change.
app.post("/api/entries/bulk-edit", (req, res) => {
  const patches = Array.isArray(req.body?.patches) ? req.body.patches : [];
  if (patches.length === 0) return res.status(400).json({ error: "patches[] is required" });
  let n = 0;
  const upd = db.prepare(
    "UPDATE entries SET ticket=@ticket, description=@description, day=@day, duration_ms=@duration_ms WHERE id=@id"
  );
  const tx = db.transaction((list) => {
    for (const p of list) {
      const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(p.id);
      if (!row) continue;
      upd.run({
        id: p.id,
        ticket: "ticket" in p ? (p.ticket ? String(p.ticket).trim() : null) : row.ticket,
        description: "description" in p ? String(p.description || "") : row.description,
        day: "day" in p && p.day ? String(p.day) : row.day,
        duration_ms:
          "minutes" in p && Number.isFinite(Number(p.minutes))
            ? Math.max(0, Math.round(Number(p.minutes) * 60000))
            : row.duration_ms,
      });
      n++;
    }
  });
  tx(patches);
  res.json({ updated: n });
});

// --- summary (grouped by day then ticket) ----------------------------------

app.get("/api/summary", (req, res) => {
  importFromJson();
  const { where, params } = entryWhere(req.query);
  const byProject = db
    .prepare(
      `SELECT COALESCE(${PROJECT_EXPR},'(no ticket)') AS project,
              SUM(duration_ms) AS ms, COUNT(*) AS n
       FROM entries ${where} GROUP BY project ORDER BY ms DESC`
    )
    .all(params);
  const total = byProject.reduce((a, r) => a + r.ms, 0);
  res.json({ byProject, totalMs: total });
});

// --- stats (KPIs incl. running flex-time ledger) ---------------------------

app.get("/api/stats", (req, res) => {
  importFromJson();
  const s = getSettings();
  const workDays = new Set(s.workDays);
  const weeklyTargetMs = s.targetHoursPerWeek * 3600000;
  const dailyTargetMs = workDays.size ? Math.round(weeklyTargetMs / workDays.size) : 0;

  // Per-day totals across everything (for the all-time flex ledger).
  const perDay = db
    .prepare(`SELECT day, SUM(duration_ms) AS ms FROM entries GROUP BY day`)
    .all();
  const msByDay = Object.fromEntries(perDay.map((r) => [r.day, r.ms]));

  // Flex ledger over COMPLETED days only (first tracked day .. yesterday):
  // worked minus expected (workdays * daily target). Overtime & weekend work
  // push it positive; missed workdays push it negative.
  let flexBalanceMs = 0;
  if (perDay.length) {
    const first = perDay.map((r) => r.day).sort()[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const lastStr = ymd(yesterday);
    if (first <= lastStr) {
      eachDay(first, lastStr, (d) => {
        const worked = msByDay[ymd(d)] || 0;
        const expected = workDays.has(d.getDay()) ? dailyTargetMs : 0;
        flexBalanceMs += worked - expected;
      });
    }
  }

  // Range stats for the selected window.
  const { where, params } = entryWhere(req.query);
  const rangeTotalMs = db.prepare(`SELECT COALESCE(SUM(duration_ms),0) AS ms FROM entries ${where}`).get(params).ms;
  // Distinct worked days in range:
  const dww = db
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT day FROM entries ${where} GROUP BY day)`)
    .get(params).n;

  // Expected hours for the range, counting only workdays up to today.
  let expectedRangeMs = 0;
  if (req.query.from && req.query.to) {
    const today = ymd(new Date());
    const end = req.query.to < today ? req.query.to : today;
    if (req.query.from <= end) {
      eachDay(req.query.from, end, (d) => {
        if (workDays.has(d.getDay())) expectedRangeMs += dailyTargetMs;
      });
    }
  }

  res.json({
    rangeTotalMs,
    daysWithWork: dww,
    dailyAvgMs: dww ? Math.round(rangeTotalMs / dww) : 0,
    dailyTargetMs,
    weeklyTargetMs,
    expectedRangeMs,
    targetPct: expectedRangeMs ? Math.round((rangeTotalMs / expectedRangeMs) * 100) : null,
    flexBalanceMs,
  });
});

// --- heatmap (per-day totals for a year) -----------------------------------

app.get("/api/heatmap", (req, res) => {
  importFromJson();
  const year = String(req.query.year || new Date().getFullYear());
  const rows = db
    .prepare(`SELECT day, SUM(duration_ms) AS ms FROM entries WHERE day >= ? AND day <= ? GROUP BY day`)
    .all(`${year}-01-01`, `${year}-12-31`);
  res.json(Object.fromEntries(rows.map((r) => [r.day, r.ms])));
});

// --- UI timer --------------------------------------------------------------

app.get("/api/timer", (req, res) => res.json(kvGet("timer", null)));

app.post("/api/timer/start", (req, res) => {
  if (kvGet("timer", null)) return res.status(409).json({ error: "a timer is already running" });
  const timer = {
    description: req.body?.description ? String(req.body.description).trim() : "",
    ticket: req.body?.ticket ? String(req.body.ticket).trim() : null,
    start: new Date().toISOString(),
  };
  kvSet("timer", timer);
  res.status(201).json(timer);
});

app.post("/api/timer/stop", (req, res) => {
  const timer = kvGet("timer", null);
  if (!timer) return res.status(404).json({ error: "no timer running" });
  const end = new Date().toISOString();
  const duration_ms = Math.max(0, new Date(end) - new Date(timer.start));
  const id = "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  insertEntry.run({
    id,
    source: "manual",
    ticket: timer.ticket || null,
    description: timer.description || "(timer)",
    day: dayOf(end),
    start: timer.start,
    end,
    duration_ms,
    repo: null,
    commit_hash: null,
    created_at: end,
  });
  kvSet("timer", null);
  res.json(db.prepare("SELECT * FROM entries WHERE id = ?").get(id));
});

// --- batch import (used by the Outlook importer) ---------------------------
// Accepts [{id, ticket, description, day, start, end, durationMs}] and upserts
// them as manual entries (INSERT OR IGNORE by id; skips deleted ids).
app.post("/api/import", (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [];
  const deleted = new Set(kvGet("deleted", []));
  let added = 0;
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      if (!e || typeof e.id !== "string" || deleted.has(e.id)) continue;
      const r = insertEntry.run({
        id: e.id,
        source: "manual",
        ticket: e.ticket || null,
        description: e.description || "",
        day: e.day || dayOf(e.end || e.start),
        start: e.start || null,
        end: e.end || null,
        duration_ms: e.durationMs || 0,
        repo: null,
        commit_hash: null,
        created_at: e.end || e.start || new Date().toISOString(),
      });
      added += r.changes;
    }
  });
  tx(items);
  logLine("import", "INFO", `received ${items.length}, added ${added}`);
  res.json({ added });
});

// --- logs ------------------------------------------------------------------

app.get("/api/logs", (req, res) => {
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 300));
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
  } catch {}
  if (lines.length > 2000) {
    try { fs.writeFileSync(LOG_FILE, lines.slice(-2000).join("\n") + "\n"); } catch {}
    lines = lines.slice(-2000);
  }
  res.json({ lines: lines.slice(-limit).reverse() }); // newest first
});

// Lets any client (incl. the host importer) push a log line.
app.post("/api/log", (req, res) => {
  const { source, level, msg } = req.body || {};
  logLine(
    source ? String(source).slice(0, 20) : "app",
    level ? String(level).slice(0, 10) : "INFO",
    msg || ""
  );
  res.json({ ok: true });
});

// --- Jira (read-only, optional) --------------------------------------------

// Frontend config (safe values only — never the token).
app.get("/api/config", (req, res) => {
  res.json({ jiraBaseUrl: JIRA_BASE || null, jiraEnrich: !!(JIRA_BASE && JIRA_TOKEN) });
});

// Ticket enrichment: title + status. Cached briefly to avoid hammering Jira.
const jiraCache = new Map();
app.get("/api/jira/:key", async (req, res) => {
  if (!JIRA_BASE || !JIRA_TOKEN) return res.status(404).json({ error: "jira not configured" });
  const key = req.params.key;
  const hit = jiraCache.get(key);
  if (hit && Date.now() - hit.t < 300000) return res.json(hit.v);
  try {
    const r = await fetch(`${JIRA_BASE}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status`, {
      headers: { Authorization: `Bearer ${JIRA_TOKEN}`, Accept: "application/json" },
    });
    if (!r.ok) { logLine("jira", "WARN", `${key} -> HTTP ${r.status}`); return res.status(r.status).json({ error: `jira ${r.status}` }); }
    const d = await r.json();
    const v = {
      key,
      summary: d.fields?.summary || "",
      status: d.fields?.status?.name || "",
      url: `${JIRA_BASE}/browse/${key}`,
    };
    jiraCache.set(key, { t: Date.now(), v });
    res.json(v);
  } catch (e) {
    logLine("jira", "ERROR", `${key} -> ${e.message || e}`);
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

const STATIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get("*", (req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));
}

app.listen(PORT, () => {
  console.log(`time-tracker web listening on http://localhost:${PORT}`);
  console.log(`  data dir: ${DATA_DIR}`);
  logLine("server", "INFO", `started on ${PORT}; jira ${JIRA_BASE ? "configured" : "off"}`);
});
