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
 * Lightweight chart with HTML-rendered axis labels and an SVG line/area body.
 * Text outside the SVG never distorts when the chart stretches to fill width.
 */
export default function TrendChart({
  data,
  height = 220,
  colorToken = "ppp-blue",
  yFormat = "number",
  area = true,
}: Props) {
  const gradientId = useId();
  const Y_LABEL_W = 44;
  const X_LABEL_H = 22;

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
  const yMax = max + range * 0.18;
  const yMin = Math.max(0, min - range * 0.1);
  const yRange = Math.max(1, yMax - yMin);

  // Coordinates in viewBox 0..100 (both axes). SVG stretches to fill container;
  // text labels live outside the SVG so they always render crisp.
  const xAt = (i: number) =>
    data.length === 1 ? 50 : (i / (data.length - 1)) * 100;
  const yAt = (v: number) => (1 - (v - yMin) / yRange) * 100;

  const linePath = data
    .map((d, i) => {
      const px = xAt(i);
      const py = yAt(d.value);
      if (i === 0) return `M ${px} ${py}`;
      const prevX = xAt(i - 1);
      const prevY = yAt(data[i - 1].value);
      const cx = (prevX + px) / 2;
      return `C ${cx} ${prevY}, ${cx} ${py}, ${px} ${py}`;
    })
    .join(" ");

  const areaPath = `${linePath} L ${xAt(data.length - 1)} 100 L ${xAt(0)} 100 Z`;

  // Show every label up to 8 points; every other label beyond that.
  const labelEvery = data.length > 8 ? 2 : 1;

  return (
    <div
      className="relative w-full"
      style={{ height, paddingLeft: Y_LABEL_W, paddingBottom: X_LABEL_H }}
    >
      {/* Y-axis labels (top + bottom) */}
      <div
        className="absolute left-0 top-0 text-[10px] font-medium text-ppp-charcoal-500"
        style={{ width: Y_LABEL_W, paddingRight: 8, textAlign: "right" }}
      >
        {formatValue(yMax, yFormat)}
      </div>
      <div
        className="absolute left-0 text-[10px] font-medium text-ppp-charcoal-500"
        style={{
          width: Y_LABEL_W,
          paddingRight: 8,
          textAlign: "right",
          bottom: X_LABEL_H,
          transform: "translateY(50%)",
        }}
      >
        {formatValue(yMin, yFormat)}
      </div>

      {/* SVG chart body (fills the inner area) */}
      <div className="relative w-full h-full">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
          role="img"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={`var(--color-${colorToken})`} stopOpacity="0.22" />
              <stop offset="100%" stopColor={`var(--color-${colorToken})`} stopOpacity="0" />
            </linearGradient>
          </defs>

          {[0, 25, 50, 75, 100].map((p, i) => (
            <line
              key={p}
              x1="0"
              x2="100"
              y1={p}
              y2={p}
              stroke="var(--color-ppp-charcoal-100)"
              strokeWidth="0.25"
              strokeDasharray={i === 4 ? "0" : "0.6 0.8"}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {area && <path d={areaPath} fill={`url(#${gradientId})`} />}
          <path
            d={linePath}
            fill="none"
            stroke={`var(--color-${colorToken})`}
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Data point markers (HTML, never distort with SVG stretching) */}
        {data.map((d, i) => {
          const isLast = i === data.length - 1;
          return (
            <span
              key={i}
              className="absolute rounded-full border-2 bg-white pointer-events-none"
              style={{
                left: `${xAt(i)}%`,
                top: `${yAt(d.value)}%`,
                width: isLast ? 9 : 6,
                height: isLast ? 9 : 6,
                transform: "translate(-50%, -50%)",
                borderColor: `var(--color-${colorToken})`,
              }}
            />
          );
        })}
      </div>

      {/* X-axis labels (anchored under each data point column) */}
      <div
        className="absolute left-0 right-0 bottom-0 pointer-events-none"
        style={{ paddingLeft: Y_LABEL_W, height: X_LABEL_H }}
      >
        <div className="relative w-full h-full">
          {data.map((d, i) => {
            if (i % labelEvery !== 0 && i !== data.length - 1) return null;
            return (
              <span
                key={i}
                className="absolute top-1.5 text-[10px] font-medium text-ppp-charcoal-500 whitespace-nowrap"
                style={{ left: `${xAt(i)}%`, transform: "translateX(-50%)" }}
              >
                {d.label}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
