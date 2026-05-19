"use client";

import { useEffect, useId, useRef, useState } from "react";

export type ChartPoint = {
  label: string;
  value: number;
  meta?: {
    topRegion?: { region: string; revenue: number };
    topRep?: { name: string; revenue: number };
    deals?: number;
  };
};

type YFormat = "currency-k" | "percent" | "number";

type Props = {
  data: ChartPoint[];
  /** Tailwind height classes — defaults to responsive `h-[200px] sm:h-[260px]` */
  heightClassName?: string;
  colorToken?: string;
  yFormat?: YFormat;
  area?: boolean;
};

function formatValue(v: number, fmt: YFormat): string {
  if (fmt === "currency-k") return `$${Math.round(v)}K`;
  if (fmt === "percent") return `${v.toFixed(1)}%`;
  return `${Math.round(v)}`;
}

/**
 * Mobile-perfect line/area chart.
 * - HTML axis labels (never distort with SVG stretching).
 * - `touch-action: pan-y` so the page still scrolls when finger crosses the chart.
 * - Adaptive X-label and marker thinning based on container width + point count.
 * - Tooltip auto-clamps to viewport and flips above/below the line as needed.
 */
export default function TrendChart({
  data,
  heightClassName = "h-[200px] sm:h-[260px]",
  colorToken = "ppp-blue",
  yFormat = "number",
  area = true,
}: Props) {
  const gradientId = useId();
  const Y_LABEL_W = 40;
  const X_LABEL_H = 22;
  const plotRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [plotWidth, setPlotWidth] = useState<number>(0);

  // Observe plot width so label thinning adapts to actual rendered width.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setPlotWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setPlotWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  if (data.length === 0) {
    return (
      <div className={`flex items-center justify-center text-xs text-ppp-charcoal-500 ${heightClassName}`}>
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

  // Adaptive label thinning: estimate ~50px per label, divide actual width by that.
  const maxLabels = Math.max(2, Math.floor(plotWidth / 50)) || 6;
  const labelEvery =
    data.length <= maxLabels
      ? 1
      : Math.ceil(data.length / maxLabels);

  // Aggressive marker culling on narrow screens. On daily 30-day series we want
  // only first/last/hover markers visible so the line stays clean.
  const hideIntermediateMarkers = data.length > 14;

  const handleMove = (clientX: number) => {
    const el = plotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = (clientX - rect.left) / Math.max(1, rect.width);
    if (data.length === 1) {
      setHoverIdx(0);
      return;
    }
    const idx = Math.round(rel * (data.length - 1));
    setHoverIdx(Math.max(0, Math.min(data.length - 1, idx)));
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

  // Tooltip horizontal clamping — keep it inside the plot area.
  const tooltipLeftClamp =
    hoverIdx === null ? 50 : activeX < 22 ? 22 : activeX > 78 ? 78 : activeX;

  // Flip tooltip below the line if it would overflow the top of the chart.
  const tooltipBelow = activeY < 28; // top quarter

  const hasMeta =
    !!active?.meta && (!!active.meta.topRegion || !!active.meta.topRep || !!active.meta.deals);

  return (
    <div className={`relative w-full ${heightClassName}`}>
      <div
        className="relative w-full h-full"
        style={{ paddingLeft: Y_LABEL_W, paddingBottom: X_LABEL_H }}
      >
        {/* Y-axis labels */}
        <div
          className="absolute left-0 top-0 text-[10px] font-medium text-ppp-charcoal-500"
          style={{ width: Y_LABEL_W, paddingRight: 6, textAlign: "right" }}
        >
          {formatValue(yMax, yFormat)}
        </div>
        <div
          className="absolute left-0 text-[10px] font-medium text-ppp-charcoal-500"
          style={{
            width: Y_LABEL_W,
            paddingRight: 6,
            textAlign: "right",
            bottom: X_LABEL_H,
            transform: "translateY(50%)",
          }}
        >
          {formatValue(yMin, yFormat)}
        </div>

        {/* SVG + hover layer */}
        <div
          ref={plotRef}
          className="relative w-full h-full"
          style={{ touchAction: "pan-y" }}
          onMouseMove={onMouseMove}
          onMouseLeave={onLeave}
          onTouchStart={onTouchMove}
          onTouchMove={onTouchMove}
          onTouchEnd={onLeave}
          onTouchCancel={onLeave}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full"
            role="img"
            aria-label={`Trend chart with ${data.length} data points`}
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

          {/* Data point markers */}
          {data.map((d, i) => {
            const isLast = i === data.length - 1;
            const isFirst = i === 0;
            const isHover = hoverIdx === i;
            if (hideIntermediateMarkers && !isLast && !isFirst && !isHover) return null;
            return (
              <span
                key={i}
                className="absolute rounded-full border-2 bg-white pointer-events-none transition-all"
                style={{
                  left: `${xAt(i)}%`,
                  top: `${yAt(d.value)}%`,
                  width: isHover ? 11 : isLast ? 8 : 5,
                  height: isHover ? 11 : isLast ? 8 : 5,
                  transform: "translate(-50%, -50%)",
                  borderColor: `var(--color-${colorToken})`,
                }}
              />
            );
          })}

          {/* Tooltip */}
          {active && (
            <div
              className="absolute pointer-events-none z-10"
              style={{
                left: `${tooltipLeftClamp}%`,
                top: `${activeY}%`,
                transform: tooltipBelow
                  ? "translate(-50%, calc(100% + 14px))"
                  : "translate(-50%, calc(-100% - 14px))",
              }}
            >
              <div className="px-3 py-2 rounded-md bg-ppp-charcoal text-white shadow-lg shadow-ppp-charcoal/25 whitespace-nowrap max-w-[200px]">
                <div className="text-[10px] uppercase tracking-wide opacity-70 leading-none">
                  {active.label}
                </div>
                <div className="mt-1 text-sm font-bold leading-none">
                  {formatValue(active.value, yFormat)}
                </div>
                {hasMeta && (
                  <div className="mt-2 pt-2 border-t border-white/15 space-y-0.5 text-[10px] leading-snug opacity-90">
                    {active.meta?.topRegion && (
                      <div>
                        <span className="opacity-60">Top region: </span>
                        <span className="font-semibold">{active.meta.topRegion.region}</span>
                        {active.meta.topRegion.revenue > 0 && (
                          <span className="opacity-60"> · ${active.meta.topRegion.revenue}K</span>
                        )}
                      </div>
                    )}
                    {active.meta?.topRep && (
                      <div>
                        <span className="opacity-60">Top rep: </span>
                        <span className="font-semibold">{active.meta.topRep.name}</span>
                      </div>
                    )}
                    {typeof active.meta?.deals === "number" && (
                      <div>
                        <span className="opacity-60">Deals: </span>
                        <span className="font-semibold">{active.meta.deals}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* Tooltip arrow — flips with the bubble */}
              <div
                className="absolute left-1/2 -translate-x-1/2"
                style={
                  tooltipBelow
                    ? {
                        top: -5,
                        width: 0,
                        height: 0,
                        borderLeft: "5px solid transparent",
                        borderRight: "5px solid transparent",
                        borderBottom: "5px solid var(--color-ppp-charcoal)",
                      }
                    : {
                        bottom: -5,
                        width: 0,
                        height: 0,
                        borderLeft: "5px solid transparent",
                        borderRight: "5px solid transparent",
                        borderTop: "5px solid var(--color-ppp-charcoal)",
                      }
                }
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
              const isLast = i === data.length - 1;
              const isFirst = i === 0;
              const isHover = hoverIdx === i;
              const showByRule = isFirst || isLast || i % labelEvery === 0;
              if (!showByRule && !isHover) return null;
              // Compensate the first / last labels horizontally so they don't clip the card edge.
              const xPct = xAt(i);
              const transform =
                isFirst && xPct < 5
                  ? "translateX(-15%)"
                  : isLast && xPct > 95
                  ? "translateX(-85%)"
                  : "translateX(-50%)";
              return (
                <span
                  key={i}
                  className={[
                    "absolute top-1.5 text-[10px] font-medium whitespace-nowrap transition-colors",
                    isHover ? "text-ppp-charcoal font-semibold" : "text-ppp-charcoal-500",
                  ].join(" ")}
                  style={{ left: `${xPct}%`, transform }}
                >
                  {d.label}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
