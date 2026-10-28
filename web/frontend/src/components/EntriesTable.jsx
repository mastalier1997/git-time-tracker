import React, { useMemo, useState, useEffect } from "react";
import { api, fmtDuration } from "../api.js";

// Collapse entries into groups: one per (day, ticket). Entries without a
// ticket, and Outlook calendar entries (id "ol_..."), stay separate (keyed by
// their own id). Entries arrive day-desc.
function buildGroups(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e.ticket && !e.id.startsWith("ol_") ? `${e.day}|${e.ticket}` : `${e.day}|_${e.id}`;
    let g = map.get(key);
    if (!g) {
      g = { day: e.day, ticket: e.ticket, ids: [], totalMs: 0, sources: new Set(), descriptions: [] };
      map.set(key, g);
    }
    g.ids.push(e.id);
    g.totalMs += e.duration_ms;
    g.sources.add(e.source);
    if (e.description) g.descriptions.push(e.description);
  }
  return [...map.values()];
}

export default function EntriesTable({ entries, pageSize, jira = {}, onChange }) {
  const [page, setPage] = useState(0);
  const [editGroup, setEditGroup] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const groups = useMemo(() => buildGroups(entries), [entries]);
  const dayTotals = useMemo(() => {
    const m = {};
    for (const e of entries) m[e.day] = (m[e.day] || 0) + e.duration_ms;
    return m;
  }, [entries]);

  const keyOf = (g) => g.ids.join(",");
  const toggle = (key) => setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const allKeys = groups.map(keyOf);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allKeys));
  const clearSel = () => { setSelected(new Set()); setBulkConfirm(false); };
  const selectedGroups = groups.filter((g) => selected.has(keyOf(g)));
  const selectedIds = selectedGroups.flatMap((g) => g.ids);
  const afterBulk = () => { setSelected(new Set()); setBulkConfirm(false); setBulkEditing(false); onChange(); };
  const bulkDelete = () => api.bulkRemove(selectedIds).then(afterBulk);

  const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
  const cur = Math.min(page, pageCount - 1);
  const slice = groups.slice(cur * pageSize, cur * pageSize + pageSize);

  let lastDay = null;
  const rows = [];
  for (const g of slice) {
    if (g.day !== lastDay) {
      lastDay = g.day;
      rows.push(
        <tr key={`d-${g.day}`} className="day-header">
          <td></td>
          <td colSpan={3}>{formatDay(g.day)}</td>
          <td className="num">{fmtDuration(dayTotals[g.day])}</td>
          <td></td>
        </tr>
      );
    }
    const key = keyOf(g);
    rows.push(
      <GroupRow key={key} group={g} jira={jira} selected={selected.has(key)} onToggle={() => toggle(key)} onEdit={() => setEditGroup(g)} onChange={onChange} />
    );
  }

  return (
    <div>
      {selected.size > 0 && (
        <div className="bulk-bar">
          <span className="muted">{selected.size} row{selected.size === 1 ? "" : "s"} · {selectedIds.length} entr{selectedIds.length === 1 ? "y" : "ies"}</span>
          <button className="link" onClick={() => setBulkEditing(true)}>Edit selected</button>
          {bulkConfirm ? (
            <span className="confirm-del">
              <button className="link danger" onClick={bulkDelete}>Delete {selectedIds.length}?</button>
              <button className="link" onClick={() => setBulkConfirm(false)}>Cancel</button>
            </span>
          ) : (
            <button className="link danger" onClick={() => setBulkConfirm(true)}>Delete selected</button>
          )}
          <button className="link" onClick={clearSel}>Clear</button>
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>
              <th>Ticket</th>
              <th>Description</th>
              <th>Source</th>
              <th className="num">Time</th>
              <th></th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="pager">
          <button className="link" disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹ Newer</button>
          <span className="muted">Page {cur + 1} of {pageCount}</span>
          <button className="link" disabled={cur >= pageCount - 1} onClick={() => setPage(cur + 1)}>Older ›</button>
        </div>
      )}

      {editGroup && (
        <EditModal
          group={editGroup}
          onDone={() => { setEditGroup(null); onChange(); }}
          onCancel={() => setEditGroup(null)}
        />
      )}
      {bulkEditing && (
        <BulkEditModal groups={selectedGroups} onDone={afterBulk} onCancel={() => setBulkEditing(false)} />
      )}
    </div>
  );
}

function GroupRow({ group, jira, selected, onToggle, onEdit, onChange }) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const desc = group.descriptions[0] || "(no description)";
  const doDelete = () => Promise.all(group.ids.map((id) => api.remove(id))).then(onChange);
  const copy = () => {
    const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(desc).then(flash).catch(() => { if (legacyCopy(desc)) flash(); });
    } else if (legacyCopy(desc)) {
      flash();
    }
  };
  return (
    <tr className={selected ? "row-selected" : ""}>
      <td><input type="checkbox" checked={selected} onChange={onToggle} aria-label="Select row" /></td>
      <td><TicketCell ticket={group.ticket} jira={jira} /></td>
      <td className="desc">{desc}</td>
      <td>{[...group.sources].map((s) => <span key={s} className={`tag ${s}`}>{s}</span>)}</td>
      <td className="num">{fmtDuration(group.totalMs)}</td>
      <td className="actions">
        {confirming ? (
          <span className="confirm-del">
            <button className="link danger" onClick={doDelete}>Delete?</button>
            <button className="link" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        ) : (
          <>
            <button className="link icon-btn" onClick={copy} aria-label="Copy description" title="Copy description">
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            <button className="link" onClick={onEdit}>edit</button>
            <button className="link danger icon-btn" onClick={() => setConfirming(true)} aria-label="Delete" title="Delete">
              <TrashIcon />
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

// Editing a group sets the TOTAL time (stored on the first entry, others
// zeroed) and applies ticket/day/description to the underlying entries.
function EditModal({ group, onDone, onCancel }) {
  const total = Math.round(group.totalMs / 60000);
  const [form, setForm] = useState({
    day: group.day,
    ticket: group.ticket || "",
    description: group.descriptions[0] || "",
    hours: Math.floor(total / 60),
    minutes: total % 60,
  });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setDirty(true); };
  const requestClose = () => (dirty ? setConfirmClose(true) : onCancel());

  const save = async () => {
    const mins = (Number(form.hours) || 0) * 60 + (Number(form.minutes) || 0);
    setBusy(true);
    await Promise.all(
      group.ids.map((id, i) =>
        api.updateEntry(
          id,
          i === 0
            ? { ticket: form.ticket, day: form.day, description: form.description, minutes: mins }
            : { ticket: form.ticket, day: form.day, minutes: 0 }
        )
      )
    );
    onDone();
  };

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h2>Edit entry</h2>
          <button className="link" onClick={requestClose} aria-label="Close">✕</button>
        </div>

        <label className="field-label" htmlFor="e-date">Date</label>
        <input id="e-date" type="date" value={form.day} onChange={set("day")} style={{ width: "100%" }} />

        <label className="field-label" htmlFor="e-ticket">Ticket</label>
        <input id="e-ticket" value={form.ticket} onChange={set("ticket")} placeholder="PM-123" style={{ width: "100%" }} />

        <label className="field-label" htmlFor="e-desc">Description</label>
        <input id="e-desc" value={form.description} onChange={set("description")} style={{ width: "100%" }} />

        <label className="field-label">Time spent</label>
        <div className="hm-input">
          <input type="number" min="0" value={form.hours} onChange={set("hours")} onWheel={(e) => e.target.blur()} /> <span>h</span>
          <input type="number" min="0" max="59" value={form.minutes} onChange={set("minutes")} onWheel={(e) => e.target.blur()} /> <span>m</span>
        </div>
        {group.ids.length > 1 && (
          <p className="muted" style={{ marginTop: 8 }}>Applies to all {group.ids.length} entries of this ticket on this day.</p>
        )}

        {confirmClose && <p className="muted" style={{ marginTop: 16, marginBottom: 0 }}>Discard unsaved changes?</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: confirmClose ? 8 : 16 }}>
          {confirmClose ? (
            <>
              <button onClick={() => setConfirmClose(false)}>Keep editing</button>
              <button className="danger-btn" onClick={onCancel}>Discard changes</button>
            </>
          ) : (
            <>
              <button onClick={requestClose}>Cancel</button>
              <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Edit many selected groups at once. Only the enabled fields change.
// Time is applied as each group's TOTAL (first entry gets it, rest zeroed).
function BulkEditModal({ groups, onDone, onCancel }) {
  const [setTicketOn, setSetTicketOn] = useState(false);
  const [ticket, setTicket] = useState("");
  const [setTimeOn, setSetTimeOn] = useState(false);
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const rowCount = groups.length;
  const entryCount = groups.reduce((a, g) => a + g.ids.length, 0);

  const save = async () => {
    setBusy(true);
    const mins = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
    const patches = [];
    for (const g of groups) {
      g.ids.forEach((id, i) => {
        const p = { id };
        if (setTicketOn) p.ticket = ticket.trim() || null;
        if (setTimeOn) p.minutes = i === 0 ? mins : 0;
        patches.push(p);
      });
    }
    await api.bulkEdit(patches);
    onDone();
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h2>Edit {rowCount} selected</h2>
          <button className="link" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <p className="muted" style={{ margin: "4px 0 8px" }}>Applies to {rowCount} row{rowCount === 1 ? "" : "s"} ({entryCount} entr{entryCount === 1 ? "y" : "ies"}). Only enabled fields change.</p>

        <label className="field-label check-inline">
          <input type="checkbox" checked={setTicketOn} onChange={(e) => setSetTicketOn(e.target.checked)} /> Set ticket
        </label>
        <input value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="PM-123 (blank = clear)" disabled={!setTicketOn} style={{ width: "100%" }} />

        <label className="field-label check-inline">
          <input type="checkbox" checked={setTimeOn} onChange={(e) => setSetTimeOn(e.target.checked)} /> Set time (per row total)
        </label>
        <div className="hm-input">
          <input type="number" min="0" value={hours} onChange={(e) => setHours(e.target.value)} onWheel={(e) => e.target.blur()} disabled={!setTimeOn} /> <span>h</span>
          <input type="number" min="0" max="59" value={minutes} onChange={(e) => setMinutes(e.target.value)} onWheel={(e) => e.target.blur()} disabled={!setTimeOn} /> <span>m</span>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={busy || (!setTicketOn && !setTimeOn)} onClick={save}>{busy ? "Saving…" : "Apply"}</button>
        </div>
      </div>
    </div>
  );
}

function TicketCell({ ticket, jira }) {
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState(false);
  // Only PREFIX-NUMBER ids are real Jira issues; project labels (BB10, ALLG) are not.
  const isIssue = !!ticket && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(ticket);
  useEffect(() => {
    let live = true;
    if (isIssue && jira.jiraEnrich) api.jira(ticket).then((v) => live && setInfo(v));
    return () => { live = false; };
  }, [ticket, jira.jiraEnrich, isIssue]);

  if (!ticket) return <span className="muted">—</span>;

  const copyTicket = () => {
    const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(ticket).then(flash).catch(() => { if (legacyCopy(ticket)) flash(); });
    } else if (legacyCopy(ticket)) {
      flash();
    }
  };

  const label = jira.jiraBaseUrl && isIssue ? (
    <a href={`${jira.jiraBaseUrl}/browse/${ticket}`} target="_blank" rel="noopener noreferrer" title={info?.summary || ""}>
      {ticket}
    </a>
  ) : (
    <span title={info?.summary || ""}>{ticket}</span>
  );

  return (
    <span className="ticket-cell">
      {label}
      <button className="link icon-btn ticket-copy" onClick={copyTicket} aria-label={`Copy ticket ${ticket}`} title="Copy ticket number">
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {info?.status && <span className="status-pill" title={info.summary}>{info.status}</span>}
    </span>
  );
}

// Fallback for browsers where the async Clipboard API is blocked.
function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function formatDay(day) {
  const d = new Date(day + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
