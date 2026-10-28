import React, { useEffect, useState, useCallback } from "react";
import { api } from "../api.js";

// Parse "TS [source] LEVEL message" for coloring; fall back to raw line.
function parse(line) {
  const m = line.match(/^(\S+)\s+\[([^\]]+)\]\s+(\w+)\s+([\s\S]*)$/);
  if (!m) return { ts: "", source: "", level: "INFO", msg: line };
  return { ts: m[1], source: m[2], level: m[3].toUpperCase(), msg: m[4] };
}

export default function LogsModal({ onClose }) {
  const [lines, setLines] = useState(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    api.logs(400).then((d) => setLines(d.lines)).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = (lines || [])
    .map(parse)
    .filter((r) => !errorsOnly || r.level === "ERROR" || r.level === "WARN");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal logs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h2>Logs</h2>
          <button className="link" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="row-between" style={{ margin: "4px 0 10px" }}>
          <label className="field-label check-inline" style={{ margin: 0 }}>
            <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors &amp; warnings only
          </label>
          <button onClick={load}>Refresh</button>
        </div>

        {err && <div className="error">{err}</div>}
        {lines === null ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">{errorsOnly ? "No errors or warnings logged." : "No log entries yet."}</p>
        ) : (
          <div className="log-list">
            {rows.map((r, i) => (
              <div key={i} className={`log-line lvl-${r.level.toLowerCase()}`}>
                <span className="log-ts">{r.ts.replace("T", " ").replace(/\.\d+Z$/, "")}</span>
                {r.source && <span className="log-src">{r.source}</span>}
                <span className="log-lvl">{r.level}</span>
                <span className="log-msg">{r.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
