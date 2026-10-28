import React, { useEffect, useState } from "react";
import { api, fmtDuration } from "../api.js";

export default function Timer({ onChange }) {
  const [timer, setTimer] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [form, setForm] = useState({ description: "", ticket: "" });
  const [err, setErr] = useState(null);

  const refresh = () => api.timer().then(setTimer).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer]);

  const start = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      const t = await api.startTimer(form);
      setTimer(t);
      setForm({ description: "", ticket: "" });
    } catch (e) {
      setErr(e.message);
    }
  };

  const stop = async () => {
    await api.stopTimer();
    setTimer(null);
    onChange?.();
  };

  if (timer) {
    const elapsed = now - new Date(timer.start).getTime();
    return (
      <div className="card timer running">
        <div>
          <div className="muted" style={{ fontSize: 13 }}>Running{timer.ticket ? ` · ${timer.ticket}` : ""}</div>
          <div style={{ fontSize: 15 }}>{timer.description || "(no description)"}</div>
        </div>
        <div className="timer-elapsed">{fmtDuration(elapsed)}</div>
        <button className="danger-btn" onClick={stop}>
          Stop &amp; log
        </button>
      </div>
    );
  }

  return (
    <form className="card timer" onSubmit={start}>
      <input
        placeholder="What are you working on?"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        style={{ flex: 1, minWidth: 160 }}
      />
      <input
        placeholder="Ticket (PROJ-123)"
        value={form.ticket}
        onChange={(e) => setForm({ ...form, ticket: e.target.value })}
        style={{ width: 150 }}
      />
      <button className="primary" type="submit">Start timer</button>
      {err && <div className="error" style={{ flexBasis: "100%" }}>{err}</div>}
    </form>
  );
}
