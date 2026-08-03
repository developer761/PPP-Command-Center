"use client";

/**
 * R7 — "Take the product tour" replay card. Dispatches the `cc:start-tour`
 * window event that OnboardingWalkthrough (mounted globally in the commercial
 * layout) listens for, so anyone can re-run the guided tour on demand — no need
 * to be a first-timer.
 */
export function StartTourButton() {
  return (
    <div className="mt-5 flex flex-col sm:flex-row sm:items-center gap-3 p-5 rounded-xl bg-cc-brand-50/60 border border-cc-brand-100">
      <span className="flex items-center justify-center h-10 w-10 rounded-lg bg-surface text-cc-brand-700 shrink-0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold text-ppp-charcoal">New here, or need a refresher?</div>
        <p className="text-[13px] text-ppp-charcoal-500 mt-0.5">Take the guided tour — it walks you through the whole app, section by section.</p>
      </div>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("cc:start-tour"))}
        className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 rounded-lg bg-cc-brand-600 text-white text-[13.5px] font-semibold hover:bg-cc-brand-700 min-h-[44px] shadow-sm"
      >
        Take the tour
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </button>
    </div>
  );
}
