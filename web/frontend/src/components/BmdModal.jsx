import React, { useEffect, useState } from "react";
import { api, fmtDuration, ymd, weekRange } from "../api.js";

// "day" or a number of work weeks (Mon-Fri) starting at the week of `start`.
function rangeFor(start, span) {
  if (span === "day") return { from: start, to: start };
  const week = weekRange(new Date(`${start}T00:00`)); // local midnight, not UTC
  const friday = new Date(week.monday);
  friday.setDate(friday.getDate() + 7 * Number(span) - 3);
  return { from: week.from, to: ymd(friday) };
}

const fmtDay = (day) =>
  new Date(`${day}T00:00`).toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });

export default function BmdModal({ onClose }) {
  const [start, setStart] = useState(weekRange(new Date()).from);
  const [span, setSpan] = useState("1");
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const { from, to } = rangeFor(start, span);

  useEffect(() => {
    setRows(null); setMsg(null);
    api.bmd(from, to).then((d) => setRows(d.rows)).catch((e) => setMsg({ error: e.message }));
  }, [from, to]);

  const todo = (rows || []).filter((r) => !r.booked);

  const book = () => {
    setBusy(true); setMsg(null);
    api.bmd(from, to, true)
      .then((d) => {
        setRows(d.rows);
        const { booked, existing } = d.result;
        setMsg({ ok: `Booked ${booked.length} day${booked.length === 1 ? "" : "s"} in BMD.` + (existing.length ? ` Skipped ${existing.join(", ")}: BMD already had bookings.` : "") });
      })
      .catch((e) => { setMsg({ error: e.message }); api.bmd(from, to).then((d) => setRows(d.rows)); })
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal logs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h2>Book in BMD</h2>
          <button className="link" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label className="field-label">
            Range
            <select value={span} onChange={(e) => setSpan(e.target.value)} disabled={busy}>
              <option value="day">Single day</option>
              <option value="1">Work week</option>
              <option value="2">2 work weeks</option>
              <option value="3">3 work weeks</option>
              <option value="4">4 work weeks</option>
            </select>
          </label>
          <label className="field-label">
            {span === "day" ? "Day" : "Starting week of"}
            <input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} disabled={busy} />
          </label>
        </div>
        <p className="muted">
          {from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`}. Days over 6h get a 30 min Pause booking after 6h (not counted as work). Holiday, sick and public-holiday entries are skipped, and so are days that already have bookings in BMD.
        </p>

        {rows === null ? (
          !msg && <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No tracked time in this range.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Day</th><th>BMD bookings</th><th>Worked</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.day}>
                    <td>{fmtDay(r.day)}</td>
                    <td>{r.blocks.map((b) => <div key={b.begin} style={{ whiteSpace: "nowrap" }}>{b.begin}–{b.end}{b.pause && <span className="muted"> Pause</span>}</div>)}</td>
                    <td className="num">{fmtDuration(r.minutes * 60000)}</td>
                    <td className={r.booked ? "muted" : ""}>{r.booked ? "Already booked" : "Will be booked"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {msg?.error && <div className="error">{msg.error}</div>}
        {msg?.ok && <p>{msg.ok}</p>}

        <div className="row-between" style={{ marginTop: 16 }}>
          <span className="muted">{busy ? "Booking in BMD, about 10 s per entry…" : ""}</span>
          <button className="primary" onClick={book} disabled={busy || todo.length === 0}>
            {busy ? "Booking…" : `Book ${todo.length} day${todo.length === 1 ? "" : "s"} in BMD`}
          </button>
        </div>
      </div>
    </div>
  );
}
