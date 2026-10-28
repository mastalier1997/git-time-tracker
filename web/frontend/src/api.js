const json = (r) => {
  if (!r.ok) return r.json().then((e) => Promise.reject(new Error(e.error || r.statusText)));
  return r.json();
};
const send = (method, url, body) =>
  fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

const qs = (params = {}) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();

export const api = {
  settings: () => fetch("/api/settings").then(json),
  saveSettings: (s) => send("PUT", "/api/settings", s),

  entries: (params = {}) => fetch(`/api/entries?${qs(params)}`).then(json),
  summary: (params = {}) => fetch(`/api/summary?${qs(params)}`).then(json),
  stats: (params = {}) => fetch(`/api/stats?${qs(params)}`).then(json),
  heatmap: (year) => fetch(`/api/heatmap?${qs({ year })}`).then(json),

  addManual: (entry) => send("POST", "/api/entries", entry),
  updateEntry: (id, patch) => send("PATCH", `/api/entries/${id}`, patch),
  remove: (id) => send("DELETE", `/api/entries/${id}`),

  bulkAdd: (body) => send("POST", "/api/entries/bulk", body),
  bulkRemove: (ids) => send("POST", "/api/entries/bulk-delete", { ids }),
  bulkEdit: (patches) => send("POST", "/api/entries/bulk-edit", { patches }),

  timer: () => fetch("/api/timer").then(json),
  startTimer: (t) => send("POST", "/api/timer/start", t),
  stopTimer: () => send("POST", "/api/timer/stop"),

  logs: (limit = 300) => fetch(`/api/logs?limit=${limit}`).then(json),
  config: () => fetch("/api/config").then(json),
  jira: (key) => {
    if (!jiraCache.has(key)) {
      jiraCache.set(key, fetch(`/api/jira/${encodeURIComponent(key)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    }
    return jiraCache.get(key);
  },
};

const jiraCache = new Map();

export function fmtDuration(ms) {
  const sign = ms < 0 ? "−" : "";
  const totalMin = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return sign + (h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, "0")}m`);
}

export function toCsv(entries) {
  const head = ["date", "ticket", "description", "source", "hours"];
  const rows = entries.map((e) => [
    e.day,
    e.ticket || "",
    (e.description || "").replace(/"/g, '""'),
    e.source,
    (e.duration_ms / 3600000).toFixed(2),
  ]);
  return [head, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
}

// --- date helpers (local, week starts Monday) ------------------------------

export const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function weekRange(ref) {
  const d = new Date(ref);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: ymd(monday), to: ymd(sunday), monday };
}

export function monthRange(ref) {
  const d = new Date(ref);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: ymd(first), to: ymd(last) };
}
