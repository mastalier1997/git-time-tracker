import React, { useState } from "react";

const DAYS = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 0, label: "Sun" },
];

// Tickets booked by the "Book day…" quick select. Blank fields keep the old value.
const LABELS = [
  { key: "holidayLabel", label: "Holiday", placeholder: "URLAUB" },
  { key: "unisysLabel", label: "Unisys day", placeholder: "UNISYS" },
  { key: "sickLabel", label: "Sick", placeholder: "KRANK" },
  { key: "publicHolidayLabel", label: "Public holiday", placeholder: "FEIERTAG" },
];

export default function SettingsModal({ settings, onSave, onClose, onViewLogs }) {
  const [workDays, setWorkDays] = useState(new Set(settings.workDays));
  const [target, setTarget] = useState(settings.targetHoursPerWeek);
  const [pageSize, setPageSize] = useState(settings.pageSize);
  const [labels, setLabels] = useState(() =>
    Object.fromEntries(LABELS.map((l) => [l.key, settings[l.key] || l.placeholder]))
  );
  const [holidayDays, setHolidayDays] = useState(settings.holidayDaysPerYear ?? 30);
  const [busy, setBusy] = useState(false);

  const toggle = (n) => {
    const next = new Set(workDays);
    next.has(n) ? next.delete(n) : next.add(n);
    setWorkDays(next);
  };

  const save = async () => {
    setBusy(true);
    await onSave({ workDays: [...workDays], targetHoursPerWeek: Number(target), pageSize: Number(pageSize), holidayDaysPerYear: Number(holidayDays), ...labels });
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h2>Settings</h2>
          <button className="link" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <label className="field-label">Work week</label>
        <div className="day-toggle">
          {DAYS.map((d) => (
            <button
              key={d.n}
              type="button"
              className={`day-chip ${workDays.has(d.n) ? "on" : ""}`}
              onClick={() => toggle(d.n)}
            >
              {d.label}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="target">Target hours per work week</label>
        <input
          id="target"
          type="number"
          min="0"
          step="0.5"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onWheel={(e) => e.target.blur()}
          style={{ width: 120 }}
        />
        <p className="muted" style={{ marginTop: 8 }}>
          {workDays.size
            ? `Daily target: ${(Number(target || 0) / workDays.size).toFixed(2)}h across ${workDays.size} work days`
            : "Select at least one work day"}
        </p>

        <label className="field-label" htmlFor="pageSize">Entries per page</label>
        <select id="pageSize" value={pageSize} onChange={(e) => setPageSize(e.target.value)} style={{ width: 120 }}>
          {[5, 10, 20].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>

        <label className="field-label">Day-off labels</label>
        {LABELS.map((l) => (
          <div key={l.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <label htmlFor={l.key} style={{ width: 110 }}>{l.label}</label>
            <input id={l.key} value={labels[l.key]} onChange={(e) => setLabels({ ...labels, [l.key]: e.target.value })} placeholder={l.placeholder} style={{ width: 160 }} />
          </div>
        ))}
        <p className="muted" style={{ marginTop: 6 }}>Tickets booked by “Book day…”; the day is filled with your daily target.</p>

        <label className="field-label" htmlFor="holidayDays">Holiday days per year</label>
        <input id="holidayDays" type="number" min="0" step="1" value={holidayDays} onChange={(e) => setHolidayDays(e.target.value)} onWheel={(e) => e.target.blur()} style={{ width: 120 }} />
        <p className="muted" style={{ marginTop: 6 }}>Shown on the Stats page as used vs. available.</p>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 16 }}>
          <button onClick={onViewLogs}>View logs</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
