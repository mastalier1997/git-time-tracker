import React, { useEffect, useRef } from "react";
import {
  Chart,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
} from "chart.js";

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip
);

// labels: string[]
// datasets: [{ label, data:number[], color }]  (one per project, stacked)
// target: (number|null)[]
// onBarClick: optional (index) => void
export default function DayChart({ labels, datasets, target, onBarClick }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue("--muted-foreground").trim();
    const grid = css.getPropertyValue("--border").trim();
    const font = { family: css.getPropertyValue("--font-sans").trim(), size: 12 };

    const bars = datasets.map((ds) => ({
      type: "bar",
      label: ds.label,
      data: ds.data,
      backgroundColor: ds.color,
      stack: "work",
      borderRadius: 2,
      maxBarThickness: 30,
    }));

    chartRef.current = new Chart(canvasRef.current, {
      data: {
        labels,
        datasets: [
          ...bars,
          {
            type: "line",
            label: "Target",
            data: target,
            borderColor: muted,
            borderDash: [5, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            spanGaps: false,
            stack: "target",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        onClick: (e, els) => { if (onBarClick && els.length) onBarClick(els[0].index); },
        onHover: (e, els) => { if (onBarClick) e.native.target.style.cursor = els.length ? "pointer" : "default"; },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(1)}h`,
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, border: { color: grid }, ticks: { color: muted, font, maxRotation: 0, autoSkip: true } },
          y: { stacked: true, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: muted, font, callback: (v) => `${v}h` } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [labels, datasets, target, onBarClick]);

  const perDayTotals = labels.map((l, i) => {
    const h = datasets.reduce((a, ds) => a + (ds.data[i] || 0), 0);
    return `${l} ${h.toFixed(1)}h`;
  });
  return (
    <div style={{ position: "relative", width: "100%", height: 240 }}>
      <canvas ref={canvasRef} role="img" aria-label={`Hours by project: ${perDayTotals.join(", ")}`} />
    </div>
  );
}
