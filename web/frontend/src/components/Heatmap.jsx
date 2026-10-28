import React, { useEffect, useState } from "react";
import { api, fmtDuration, ymd } from "../api.js";

// Sequential scale: one hue (Graphite --chart-1) mixed into the page background.
const LEVEL_COLORS = [
  "var(--secondary)",
  "color-mix(in srgb, var(--chart-1) 25%, var(--background))",
  "color-mix(in srgb, var(--chart-1) 50%, var(--background))",
  "color-mix(in srgb, var(--chart-1) 75%, var(--background))",
  "var(--chart-1)",
];

function level(ms) {
  const h = ms / 3600000;
  if (h <= 0) return 0;
  if (h < 2) return 1;
  if (h < 4) return 2;
  if (h < 7) return 3;
  return 4;
}

export default function Heatmap() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState({});

  useEffect(() => {
    api.heatmap(year).then(setData).catch(() => setData({}));
  }, [year]);

  // Build weeks: columns are ISO-ish weeks starting Monday, rows Mon..Sun.
  const start = new Date(year, 0, 1);
  const startDow = (start.getDay() + 6) % 7;
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - startDow);

  const weeks = [];
  const cursor = new Date(gridStart);
  for (let w = 0; w < 53; w++) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const key = ymd(cursor);
      const inYear = cursor.getFullYear() === year;
      col.push({ key, ms: data[key] || 0, inYear });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(col);
  }

  const total = Object.values(data).reduce((a, b) => a + b, 0);

  return (
    <section className="card">
      <div className="row-between" style={{ marginBottom: 12 }}>
        <h2>Activity heatmap</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="muted">{fmtDuration(total)} in {year}</span>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[year + 1, year, year - 1, year - 2].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="heatmap-scroll">
        <div className="heatmap">
          {weeks.map((col, i) => (
            <div key={i} className="hm-col">
              {col.map((cell) => (
                <div
                  key={cell.key}
                  className="hm-cell"
                  title={`${cell.key}: ${fmtDuration(cell.ms)}`}
                  style={{
                    background: LEVEL_COLORS[level(cell.ms)],
                    opacity: cell.inYear ? 1 : 0.25,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="hm-legend">
        <span className="muted">Less</span>
        {LEVEL_COLORS.map((c, i) => (
          <span key={i} className="hm-cell" style={{ background: c }} />
        ))}
        <span className="muted">More</span>
      </div>
    </section>
  );
}
