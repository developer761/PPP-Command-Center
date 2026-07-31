"use client";

/**
 * PaymentProgressBar — the "that's sick" payment bar.
 *
 * A premium, animated payment-progress meter used on the invoice detail hero
 * and the account-scoped per-deal roll-up. On mount it springs from 0 → the
 * real percentage, the number counts up in step, a soft sheen sweeps the
 * filled portion, and a glow rides the leading edge. When a payment is
 * recorded the page re-renders and the bar animates to the new level, so the
 * money visibly "fills up."
 *
 * Tone: fully paid → emerald, overdue balance → rose, partial → brand indigo.
 * Milestone ticks at 25/50/75%. At 100% the whole bar gives a gentle pulse.
 *
 * Pure CSS transitions + a tiny rAF count-up; no external deps, theme-aware.
 */

import { useEffect, useRef, useState } from "react";

type Tone = "paid" | "overdue" | "partial" | "empty";

type Props = {
  paidCents: number;
  totalCents: number;
  /** Any overdue balance in this scope — flips a partial bar to the urgent tone. */
  overdue?: boolean;
  /** Small caps label above the bar (e.g. "Payment progress"). */
  label?: string;
  /** Show the "$X of $Y" amounts on the right of the label row. */
  amounts?: { paid: string; total: string } | null;
  size?: "sm" | "md";
  /** Optional sub-line (e.g. "Includes 1 draft not yet sent"). */
  note?: string | null;
  className?: string;
};

const TONE: Record<Tone, { fill: string; glow: string; text: string }> = {
  paid: {
    fill: "linear-gradient(90deg, var(--cc-prog-emerald-a), var(--cc-prog-emerald-b))",
    glow: "var(--cc-prog-emerald-b)",
    text: "text-emerald-700",
  },
  overdue: {
    fill: "linear-gradient(90deg, var(--cc-prog-rose-a), var(--cc-prog-rose-b))",
    glow: "var(--cc-prog-rose-b)",
    text: "text-rose-700",
  },
  partial: {
    fill: "linear-gradient(90deg, var(--cc-prog-brand-a), var(--cc-prog-brand-b))",
    glow: "var(--cc-prog-brand-b)",
    text: "text-cc-brand-700",
  },
  empty: {
    fill: "linear-gradient(90deg, var(--cc-prog-brand-a), var(--cc-prog-brand-b))",
    glow: "var(--cc-prog-brand-b)",
    text: "text-ppp-charcoal-500",
  },
};

function useCountUp(target: number, run: boolean, durationMs = 900): number {
  const [val, setVal] = useState(0);
  const raf = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!run) return;
    // Guard: some sandboxes disallow performance.now-less timing; fall back
    // to the target immediately if rAF isn't available.
    if (typeof requestAnimationFrame === "undefined") {
      setVal(target);
      return;
    }
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const p = Math.min(1, (ts - startRef.current) / durationMs);
      setVal(target * ease(p));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      startRef.current = null;
    };
  }, [target, run, durationMs]);
  return val;
}

export function PaymentProgressBar({
  paidCents,
  totalCents,
  overdue = false,
  label,
  amounts,
  size = "md",
  note,
  className = "",
}: Props) {
  const pct = totalCents > 0 ? Math.min(100, Math.round((paidCents / totalCents) * 100)) : 0;
  const fullyPaid = totalCents > 0 && paidCents >= totalCents;
  const tone: Tone = fullyPaid ? "paid" : pct === 0 ? "empty" : overdue ? "overdue" : "partial";
  const t = TONE[tone];

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const shownPct = useCountUp(pct, mounted);
  const width = mounted ? pct : 0;

  const h = size === "sm" ? "h-2.5" : "h-3.5";

  return (
    <div className={className}>
      {(label || amounts) && (
        <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
          {label && (
            <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ppp-charcoal-500">
              {label}
            </div>
          )}
          {amounts && (
            <div className="text-[11px] text-ppp-charcoal-600 tabular-nums">
              <strong className={t.text}>{amounts.paid}</strong>
              <span className="text-ppp-charcoal-400"> of {amounts.total}</span>
              <span className={`ml-1.5 font-bold ${t.text}`}>{Math.round(shownPct)}%</span>
            </div>
          )}
        </div>
      )}

      {/* Track */}
      <div
        className={`relative ${h} w-full rounded-full overflow-hidden bg-ppp-charcoal-100 ${fullyPaid ? "cc-prog-pulse" : ""}`}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ? `${label}: ${pct}%` : `${pct}% paid`}
      >
        {/* Subtle inner track shading for depth */}
        <div className="absolute inset-0 rounded-full shadow-[inset_0_1px_2px_rgba(0,0,0,0.10)]" aria-hidden />
        {/* Fill */}
        <div
          className="relative h-full rounded-full will-change-[width]"
          style={{
            width: `${width}%`,
            background: t.fill,
            transition: "width 950ms cubic-bezier(.22,1,.36,1)",
            boxShadow: width > 0 ? `0 0 10px -1px ${t.glow}` : "none",
          }}
        >
          {/* Sheen sweep */}
          {width > 0 && <span className="cc-prog-sheen" aria-hidden />}
          {/* Leading-edge glow cap */}
          {width > 4 && width < 100 && (
            <span
              className="absolute right-0 top-1/2 -translate-y-1/2 h-full w-1.5 rounded-full"
              style={{ background: t.glow, boxShadow: `0 0 8px 1px ${t.glow}`, opacity: 0.9 }}
              aria-hidden
            />
          )}
        </div>
        {/* Milestone ticks (hidden once fully paid so a clean bar reads "done") */}
        {!fullyPaid &&
          [25, 50, 75].map((m) => (
            <span
              key={m}
              aria-hidden
              className="absolute top-0 bottom-0 w-px bg-white/45"
              style={{ left: `${m}%` }}
            />
          ))}
      </div>

      {note && <div className="mt-1.5 text-[10.5px] text-ppp-charcoal-500">{note}</div>}

      {/* Scoped keyframes + tone tokens (theme-aware via CSS vars). Rendered
          once per instance but identical, so the browser dedupes the rules. */}
      <style>{`
        :root {
          --cc-prog-emerald-a: #34d399; --cc-prog-emerald-b: #10b981;
          --cc-prog-rose-a: #fb7185; --cc-prog-rose-b: #f43f5e;
          /* On-brand orange (#EE662E) for the in-progress tone. */
          --cc-prog-brand-a: #f2814e; --cc-prog-brand-b: #ee662e;
        }
        :root[data-theme="dark"] {
          --cc-prog-emerald-a: #10b981; --cc-prog-emerald-b: #34d399;
          --cc-prog-rose-a: #f43f5e; --cc-prog-rose-b: #fb7185;
          --cc-prog-brand-a: #ee662e; --cc-prog-brand-b: #f2814e;
        }
        @keyframes cc-prog-sheen-kf {
          0% { transform: translateX(-120%); }
          60% { transform: translateX(320%); }
          100% { transform: translateX(320%); }
        }
        .cc-prog-sheen {
          position: absolute; top: 0; bottom: 0; left: 0; width: 40%;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
          animation: cc-prog-sheen-kf 2.8s cubic-bezier(.4,0,.2,1) infinite;
          pointer-events: none;
        }
        @keyframes cc-prog-pulse-kf {
          0%, 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0.0); }
          50% { box-shadow: 0 0 0 3px rgba(16,185,129,0.18); }
        }
        .cc-prog-pulse { animation: cc-prog-pulse-kf 2.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .cc-prog-sheen { animation: none; }
          .cc-prog-pulse { animation: none; }
        }
      `}</style>
    </div>
  );
}

export default PaymentProgressBar;
