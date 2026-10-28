import React, { useEffect, useRef } from "react";
import { Chart, DoughnutController, ArcElement, Tooltip } from "chart.js";

Chart.register(DoughnutController, ArcElement, Tooltip);

// slices: [{ label, value (hours), color }]
export default function PieChart({ slices }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const ring = css.getPropertyValue("--card").trim();
    const total = slices.reduce((a, s) => a + s.value, 0);
    const chart = new Chart(canvasRef.current, {
      type: "doughnut",
      data: {
        labels: slices.map((s) => s.label),
        datasets: [{ data: slices.map((s) => s.value), backgroundColor: slices.map((s) => s.color), borderColor: ring, borderWidth: 2 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "55%",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => `${c.label}: ${c.parsed.toFixed(1)}h (${total ? Math.round((c.parsed / total) * 100) : 0}%)`,
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [slices]);

  return (
    <div style={{ position: "relative", width: "100%", height: 240 }}>
      <canvas ref={canvasRef} role="img" aria-label={`Share by project: ${slices.map((s) => `${s.label} ${s.value.toFixed(1)}h`).join(", ")}`} />
    </div>
  );
}
