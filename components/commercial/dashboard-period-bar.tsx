"use client";

/**
 * The Commercial dashboard's period picker (Katie 2026-10-15, for Alex).
 *
 * In the URL (`?period=…&from=…&to=…`), not in component state, so Alex can
 * send Katie the exact view he is looking at and she sees the same numbers.
 *
 * Phone first: a single native <select> on narrow screens — eight 44px chips
 * wrap to three rows on a 375px phone and push the money below the fold — and
 * the chip row from `sm` up. Custom reveals two date inputs and an Apply
 * button; a half-filled custom range falls back to the default server-side
 * rather than guessing (see `dashboardRange`).
 *
 * It always states the dates it resolved to, and that the balance tiles do not
 * move with it — the first question anyone asks after changing a picker is
 * "why didn't Owed to us change?".
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { DashboardPreset } from "@/lib/commercial/reports/presets";
import { FILTER_SELECT_CLS, SELECT_BG_STYLE_COMPACT } from "@/lib/commercial/form-classnames";

export function DashboardPeriodBar({
  active,
  presets,
  resolved,
  custom,
}: {
  active: DashboardPreset;
  /** Every preset with its URL, built server-side. */
  presets: { key: DashboardPreset; label: string; href: string }[];
  /** What the active preset resolved to; null = all time. */
  resolved: { fromYmd: string; toYmd: string; label: string } | null;
  /** The custom dates currently in the URL, to prefill the inputs. */
  custom: { from: string; to: string };
}) {
  const router = useRouter();
  // Pending state so a slow period change visibly registers on a phone, and
  // `scroll: false` so changing the period never throws you back to the top.
  const [pending, startTransition] = useTransition();
  const go = (href: string) => startTransition(() => router.push(href, { scroll: false }));
  const [showCustom, setShowCustom] = useState(active === "custom");
  const [from, setFrom] = useState(custom.from || resolved?.fromYmd || "");
  const [to, setTo] = useState(custom.to || resolved?.toYmd || "");
  const fmt = (ymd: string) =>
    new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  const applyCustom = () => {
    if (!from || !to) return;
    go(`/commercial?period=custom&from=${from}&to=${to}`);
  };

  return (
    <section aria-label="Dashboard period" aria-busy={pending} className={`${pending ? "opacity-70" : ""} bg-surface border border-ppp-charcoal-100 rounded-xl px-3 sm:px-4 py-2.5 shadow-sm space-y-2`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 shrink-0">Period</span>

        {/* Phone: one control. */}
        <select
          aria-label="Dashboard period"
          // The shared chrome (a test forbids bare native selects); full width
          // here because it is the only control on the row on a phone.
          className={`${FILTER_SELECT_CLS} sm:hidden flex-1 min-w-0 max-w-none`}
          style={SELECT_BG_STYLE_COMPACT}
          value={showCustom ? "custom" : active}
          onChange={(e) => {
            const key = e.target.value as DashboardPreset;
            if (key === "custom") {
              setShowCustom(true);
              return;
            }
            setShowCustom(false);
            const p = presets.find((x) => x.key === key);
            if (p) go(p.href);
          }}
        >
          {presets.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>

        {/* Wider screens: the chips. */}
        <div className="hidden sm:flex items-center gap-1.5 flex-wrap">
          {presets.map((p) => {
            const on = p.key === active && (p.key !== "custom" || showCustom);
            const cls = `inline-flex items-center px-3 min-h-[36px] rounded-lg border text-[12px] font-semibold touch-manipulation ${
              on
                ? "bg-cc-brand-600 border-cc-brand-600 text-white"
                : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
            }`;
            return p.key === "custom" ? (
              <button key={p.key} type="button" className={cls} aria-pressed={showCustom} onClick={() => setShowCustom((v) => !v)}>
                {p.label}
              </button>
            ) : (
              <Link key={p.key} href={p.href} scroll={false} aria-current={on ? "true" : undefined} className={cls} onClick={() => setShowCustom(false)}>
                {p.label}
              </Link>
            );
          })}
        </div>
      </div>

      {showCustom && (
        <form
          className="flex items-end gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            applyCustom();
          }}
        >
          <label className="flex flex-col text-[10.5px] font-semibold text-ppp-charcoal-500">
            From
            <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} className="min-h-[44px] rounded-lg border border-ppp-charcoal-200 bg-surface px-2 text-[13px] text-ppp-charcoal" />
          </label>
          <label className="flex flex-col text-[10.5px] font-semibold text-ppp-charcoal-500">
            To
            <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} className="min-h-[44px] rounded-lg border border-ppp-charcoal-200 bg-surface px-2 text-[13px] text-ppp-charcoal" />
          </label>
          <button type="submit" disabled={!from || !to} className="min-h-[44px] px-4 rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-semibold hover:bg-cc-brand-700 disabled:opacity-50">
            Apply
          </button>
        </form>
      )}

      <p className="text-[11px] text-ppp-charcoal-500 leading-snug">
        {resolved ? (
          <>
            Showing <span className="font-semibold text-ppp-charcoal-700">{resolved.label}</span> ·{" "}
            {fmt(resolved.fromYmd)} – {fmt(resolved.toYmd)}.
          </>
        ) : (
          <>Showing <span className="font-semibold text-ppp-charcoal-700">all time</span>.</>
        )}{" "}
        Revenue, costs, profit and wins follow this period; balances (owed, pipeline, under contract) are as of today. Tap ⓘ on any figure for what it counts.
      </p>
    </section>
  );
}
