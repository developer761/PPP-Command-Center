"use client";

/**
 * R7 — one-time Commercial onboarding walkthrough.
 *
 * A minimal step-by-step overlay shown ONCE per user: the server only mounts
 * this when `profiles.commercial_onboarding_seen_at` is NULL, so every existing
 * logged-in user sees it once on their next visit, then it's stamped and never
 * returns. Finishing OR skipping POSTs to mark it seen (+ a localStorage guard
 * so a failed write can't re-nag on this device).
 *
 * Deliberately lightweight: a centered card carousel, one idea per step — no
 * DOM-spotlight tour to maintain. Mobile-perfect (44px targets), on-palette.
 */

import { useCallback, useEffect, useState } from "react";

const LS_KEY = "cc_onboarding_seen_v1";

type Step = { tone: "brand" | "green" | "navy"; title: string; body: string; icon: React.ReactNode };

const ICON = {
  wave: <path d="M12 2a5 5 0 0 0-5 5v3a5 5 0 0 0 10 0V7a5 5 0 0 0-5-5zM5 22h14M9 22v-4M15 22v-4" />,
  building: <><path d="M3 21h18M6 21V7l6-4 6 4v14M10 9h.01M14 9h.01M10 13h.01M14 13h.01M10 17h.01M14 17h.01" /></>,
  flow: <><path d="M3 7h11M3 12h7M3 17h13" /><path d="M17 4l4 4-4 4M20 15l-4 4 4 4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  check: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4 12 14.01l-3-3" /></>,
};

const STEPS: Step[] = [
  {
    tone: "brand",
    title: "Welcome to the Commercial Command Center",
    body: "Every general contractor, bid, job, and dollar in one place — from the first RFP to the final payment.",
    icon: ICON.wave,
  },
  {
    tone: "navy",
    title: "Accounts & Deals",
    body: "Each GC is an Account. Every job is a Deal with its own proposals, documents, change orders, and billing — all on one page.",
    icon: ICON.building,
  },
  {
    tone: "brand",
    title: "Win the bid, run the job",
    body: "Proposal → Work Order → AIA billing & Invoices. Once you win, the crew's paperwork and the bills flow from what you already priced.",
    icon: ICON.flow,
  },
  {
    tone: "navy",
    title: "Find anything, fast",
    body: "Press ⌘K (Ctrl+K on Windows) to jump straight to any account, deal, invoice, or document — no clicking around.",
    icon: ICON.search,
  },
  {
    tone: "green",
    title: "Stay ahead of the money",
    body: "Reports show AR aging and pipeline; each deal's “What's due” surfaces overdue bills, open COs, and submittals. That's it — you're set.",
    icon: ICON.check,
  },
];

const TONE: Record<Step["tone"], { disc: string; dot: string; btn: string }> = {
  brand: { disc: "bg-cc-brand-50 text-cc-brand-700", dot: "bg-cc-brand-500", btn: "bg-cc-brand-600 hover:bg-cc-brand-700" },
  navy: { disc: "bg-ppp-navy-50 text-ppp-navy-700", dot: "bg-ppp-navy-500", btn: "bg-cc-brand-600 hover:bg-cc-brand-700" },
  green: { disc: "bg-ppp-green-50 text-ppp-green-700", dot: "bg-ppp-green-500", btn: "bg-ppp-green-600 hover:bg-ppp-green-700" },
};

export function OnboardingWalkthrough({ firstName }: { firstName?: string | null }) {
  // If a prior dismissal's POST failed, the server may still think it's unseen —
  // the localStorage guard stops it re-nagging on this device.
  const [dismissed, setDismissed] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    try {
      if (localStorage.getItem(LS_KEY)) setDismissed(true);
    } catch {
      /* private mode — fall through, DB flag still governs */
    }
  }, []);

  const finish = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(LS_KEY, "1");
    } catch {
      /* ignore */
    }
    // Fire-and-forget — the UI already closed; the server stamp + cache bust
    // keep it from returning on the next navigation.
    void fetch("/api/commercial/onboarding/seen", { method: "POST" }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") setI((n) => Math.min(STEPS.length - 1, n + 1));
      else if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  if (dismissed) return null;

  const step = STEPS[i];
  const tone = TONE[step.tone];
  const isLast = i === STEPS.length - 1;
  const isFirst = i === 0;
  const title = isFirst && firstName ? `Welcome, ${firstName}` : step.title;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-ppp-navy-900/40 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cc-onb-title"
    >
      <div className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">
        {/* Header row — step count + Skip */}
        <div className="flex items-center justify-between px-5 pt-4">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-ppp-charcoal-400">
            {i + 1} of {STEPS.length}
          </span>
          <button
            type="button"
            onClick={finish}
            className="text-[12.5px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal px-2 py-1 min-h-[36px]"
          >
            Skip
          </button>
        </div>

        <div className="px-6 pb-2 pt-3 text-center">
          <div className={`mx-auto mb-4 inline-flex items-center justify-center h-14 w-14 rounded-2xl ${tone.disc}`}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {step.icon}
            </svg>
          </div>
          <h2 id="cc-onb-title" className="text-lg font-bold text-ppp-charcoal">
            {title}
          </h2>
          <p className="text-[13.5px] leading-relaxed text-ppp-charcoal-500 mt-2 max-w-sm mx-auto">{step.body}</p>
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5 py-4">
          {STEPS.map((_, n) => (
            <span
              key={n}
              className={`h-1.5 rounded-full transition-all ${n === i ? `w-5 ${tone.dot}` : "w-1.5 bg-ppp-charcoal-200"}`}
            />
          ))}
        </div>

        {/* Footer nav */}
        <div className="flex items-center gap-2 px-5 pb-5">
          {!isFirst && (
            <button
              type="button"
              onClick={() => setI((n) => Math.max(0, n - 1))}
              className="inline-flex items-center justify-center px-4 rounded-lg border border-ppp-charcoal-200 text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => (isLast ? finish() : setI((n) => Math.min(STEPS.length - 1, n + 1)))}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg text-white text-[14px] font-semibold min-h-[44px] shadow-sm ${tone.btn}`}
          >
            {isLast ? "Get started" : "Next"}
            {!isLast && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
