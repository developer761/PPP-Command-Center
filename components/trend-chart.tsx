"use client";

import { useId, useRef, useState } from "react";

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
 * Adds interactive hover: vertical guideline + tooltip showing the nearest
 * data point's label + value. Touch-friendly (responds to touchmove too).
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
  const plotRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

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

  const labelEvery = data.length > 8 ? 2 : 1;

  const handleMove = (clientX: number) => {
    const el = plotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = (clientX - rect.left) / Math.max(1, rect.width); // 0..1
    if (data.length === 1) {
      setHoverIdx(0);
      return;
    }
    const idx = Math.round(rel * (data.length - 1));
    const clamped = Math.max(0, Math.min(data.length - 1, idx));
    setHoverIdx(clamped);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => handleMove(e.clientX);
  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    if (t) handleMove(t.clientX);
  };
  const onLeave = () => setHoverIdx(null);

  const active = hoverIdx !== null ? data[hoverIdx] : null;
  const activeX = hoverIdx !== null ? xAt(hoverIdx) : 0;
  const activeY = active ? yAt(active.value) : 0;

  // Tooltip horizontal placement — clamp near edges so it doesn't overflow.
  const tooltipLeftClamp = hoverIdx === null
    ? 50
    : activeX < 14
    ? 14
    : activeX > 86
    ? 86
    : activeX;

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

      {/* SVG chart body + hover layer */}
      <div
        ref={plotRef}
        className="relative w-full h-full"
        onMouseMove={onMouseMove}
        onMouseLeave={onLeave}
        onTouchStart={onTouchMove}
        onTouchMove={onTouchMove}
        onTouchEnd={onLeave}
      >
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

          {/* Hover vertical guideline */}
          {hoverIdx !== null && (
            <line
              x1={activeX}
              x2={activeX}
              y1={0}
              y2={100}
              stroke={`var(--color-${colorToken})`}
              strokeWidth="1"
              strokeDasharray="2 3"
              strokeOpacity="0.55"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* Static data point markers */}
        {data.map((d, i) => {
          const isLast = i === data.length - 1;
          const isHover = hoverIdx === i;
          return (
            <span
              key={i}
              className="absolute rounded-full border-2 bg-white pointer-events-none transition-all"
              style={{
                left: `${xAt(i)}%`,
                top: `${yAt(d.value)}%`,
                width: isHover ? 11 : isLast ? 9 : 6,
                height: isHover ? 11 : isLast ? 9 : 6,
                transform: "translate(-50%, -50%)",
                borderColor: `var(--color-${colorToken})`,
                boxShadow: isHover ? `0 0 0 4px var(--color-${colorToken}) / 15%, 0 0 0 4px color-mix(in srgb, var(--color-${colorToken}) 18%, transparent)` : "none",
              }}
            />
          );
        })}

        {/* Hover tooltip */}
        {active && (
          <div
            className="absolute pointer-events-none z-10"
            style={{
              left: `${tooltipLeftClamp}%`,
              top: `${activeY}%`,
              transform: "translate(-50%, calc(-100% - 12px))",
            }}
          >
            <div className="px-2.5 py-1.5 rounded-md bg-ppp-charcoal text-white shadow-lg shadow-ppp-charcoal/20 whitespace-nowrap">
              <div className="text-[10px] uppercase tracking-wide opacity-70 leading-none">
                {active.label}
              </div>
              <div className="mt-1 text-sm font-bold leading-none">
                {formatValue(active.value, yFormat)}
              </div>
            </div>
            <div
              className="absolute left-1/2 -translate-x-1/2 -bottom-1"
              style={{
                width: 0,
                height: 0,
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderTop: "5px solid var(--color-ppp-charcoal)",
              }}
            />
          </div>
        )}
      </div>

      {/* X-axis labels */}
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
                className={[
                  "absolute top-1.5 text-[10px] font-medium whitespace-nowrap transition-colors",
                  hoverIdx === i ? "text-ppp-charcoal font-semibold" : "text-ppp-charcoal-500",
                ].join(" ")}
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
