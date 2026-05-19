"use client";

import { useId } from "react";

type Point = { label: string; value: number };

type YFormat = "currency-k" | "percent" | "number";

type Props = {
  data: Point[];
  height?: number;
  /** Tailwind color name token, e.g. "ppp-blue" */
  colorToken?: string;
  /** Declarative Y-axis format (functions can't cross the server→client boundary) */
  yFormat?: YFormat;
  /** Show area fill under the line */
  area?: boolean;
};

function formatValue(v: number, fmt: YFormat): string {
  if (fmt === "currency-k") return `$${Math.round(v)}K`;
  if (fmt === "percent") return `${v.toFixed(1)}%`;
  return `${Math.round(v)}`;
}

/**
 * Lightweight SVG line/area chart. Renders nicely from ~6 to ~60 points.
 * No external charting lib — keeps bundle lean and styling 100% on-brand.
 */
export default function TrendChart({
  data,
  height = 220,
  colorToken = "ppp-blue",
  yFormat = "number",
  area = true,
}: Props) {
  const gradientId = useId();
  const width = 800; // viewBox width; SVG scales to container
  const padX = 28;
  const padTop = 16;
  const padBottom = 28;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-ppp-charcoal-500"
        style={{ height }}
      >
        No data
      </div>
    );
  }

  const values = data.map((d) => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  // Add a little headroom so the line doesn't kiss the top edge.
  const yMax = max + range * 0.18;
  const yMin = Math.max(0, min - range * 0.1);
  const yRange = Math.max(1, yMax - yMin);

  const x = (i: number) =>
    padX + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => padTop + (1 - (v - yMin) / yRange) * innerH;

  // Smooth curve via cardinal-spline-ish midpoint interpolation
  const linePath = data
    .map((d, i) => {
      const px = x(i);
      const py = y(d.value);
      if (i === 0) return `M ${px} ${py}`;
      const prevX = x(i - 1);
      const prevY = y(data[i - 1].value);
      const cx = (prevX + px) / 2;
      return `C ${cx} ${prevY}, ${cx} ${py}, ${px} ${py}`;
    })
    .join(" ");

  const areaPath = `${linePath} L ${x(data.length - 1)} ${padTop + innerH} L ${x(0)} ${
    padTop + innerH
  } Z`;

  // Reference grid lines (4 horizontal)
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((p) => padTop + p * innerH);

  // X-axis labels — show every Nth so they don't overlap on long series
  const labelEvery = Math.max(1, Math.round(data.length / 8));

  const fmt = (v: number) => formatValue(v, yFormat);

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={`var(--color-${colorToken})`} stopOpacity="0.22" />
            <stop offset="100%" stopColor={`var(--color-${colorToken})`} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grid */}
        {gridY.map((gy, i) => (
          <line
            key={i}
            x1={padX}
            x2={width - padX}
            y1={gy}
            y2={gy}
            stroke="var(--color-ppp-charcoal-100)"
            strokeDasharray={i === gridY.length - 1 ? "0" : "3 4"}
          />
        ))}

        {area && (
          <path d={areaPath} fill={`url(#${gradientId})`} />
        )}
        <path
          d={linePath}
          fill="none"
          stroke={`var(--color-${colorToken})`}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Points */}
        {data.map((d, i) => (
          <g key={i}>
            <circle
              cx={x(i)}
              cy={y(d.value)}
              r={i === data.length - 1 ? 4.5 : 3}
              fill="white"
              stroke={`var(--color-${colorToken})`}
              strokeWidth="2"
            />
          </g>
        ))}

        {/* X labels */}
        {data.map((d, i) => {
          if (i % labelEvery !== 0 && i !== data.length - 1) return null;
          return (
            <text
              key={i}
              x={x(i)}
              y={height - 8}
              textAnchor="middle"
              className="fill-ppp-charcoal-500"
              style={{ fontSize: 10, fontWeight: 500 }}
            >
              {d.label}
            </text>
          );
        })}

        {/* Y axis: min + max labels */}
        <text
          x={padX - 6}
          y={y(yMin) + 3}
          textAnchor="end"
          className="fill-ppp-charcoal-500"
          style={{ fontSize: 10 }}
        >
          {fmt(Math.round(yMin))}
        </text>
        <text
          x={padX - 6}
          y={y(yMax) + 3}
          textAnchor="end"
          className="fill-ppp-charcoal-500"
          style={{ fontSize: 10 }}
        >
          {fmt(Math.round(yMax))}
        </text>
      </svg>
    </div>
  );
}
