"use client";

/**
 * R7 — one-time Commercial onboarding GUIDED TOUR.
 *
 * Physically walks the user through the app: each "Next" navigates to that
 * section and spotlights the real sidebar item, so they watch the pages change
 * as they go. Works because the tour is mounted in the commercial LAYOUT, which
 * persists across client-side navigation — so tour state survives router.push().
 *
 * Shown ONCE automatically (autoStart=true when the server sees a NULL
 * `profiles.commercial_onboarding_seen_at`). Finish/Skip stamps it (+ a
 * localStorage guard so a failed write can't re-nag on this device).
 *
 * ALWAYS mounted, though — so a "Take the tour" button anywhere can replay it on
 * demand by dispatching a `cc:start-tour` window event (ignores the seen guards).
 *
 * Robust by design: if a step's target isn't visible (e.g. the sidebar is
 * collapsed into a drawer on mobile), that step falls back to a centered card —
 * the navigation still happens, so they still see every page. No external tour
 * library, no brittle spotlight math beyond the target's own bounding box.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const LS_KEY = "cc_onboarding_seen_v1";
const SS_STEP = "cc_onboarding_step_v1";

type TourStep = {
  route?: string;
  target?: string; // CSS selector of the real element to spotlight
  title: string;
  body: string;
};

const STEPS: TourStep[] = [
  {
    route: "/commercial",
    title: "Welcome to the Commercial Command Center",
    body: "Quick tour — I'll walk you through the app. Every GC, bid, job, and dollar lives here. Hit Next and watch.",
  },
  {
    route: "/commercial/accounts",
    target: '[data-tour="/commercial/accounts"]',
    title: "Accounts",
    body: "Every general contractor you work with. Open one to see all their jobs, contacts, and compliance docs in a single place.",
  },
  {
    route: "/commercial/opportunities",
    target: '[data-tour="/commercial/opportunities"]',
    title: "Opportunities — your pipeline",
    body: "Every bid in flight, by stage: Qualifying → Estimating → Proposal out. This is where a new job starts.",
  },
  {
    route: "/commercial/proposals",
    target: '[data-tour="/commercial/proposals"]',
    title: "Proposals",
    body: "Build and send the bid. It runs through an approval sign-off before it can reach the GC, so nothing goes out unchecked.",
  },
  {
    route: "/commercial/projects",
    target: '[data-tour="/commercial/projects"]',
    title: "Projects — running the job",
    body: "Once you win, the job lives here: Work Orders for the crew, submittals, change orders, AIA billing, and costs — all off what you priced.",
  },
  {
    route: "/commercial/invoices",
    target: '[data-tour="/commercial/invoices"]',
    title: "Invoices",
    body: "The actual money requests to the GC, with payments and past-due reminders tracked automatically.",
  },
  {
    route: "/commercial/reports",
    target: '[data-tour="/commercial/reports"]',
    title: "Reports",
    body: "See the whole book at a glance — AR aging (who owes what), pipeline value, and win/loss. Export any of it to CSV.",
  },
  {
    route: "/commercial",
    title: "You're all set",
    body: "One last thing: press ⌘K (Ctrl+K on Windows) anywhere to jump straight to any account, deal, invoice, or document. That's the tour!",
  },
];

/** First on-screen, laid-out match for a selector — else null (→ centered card). */
function findVisibleTarget(sel: string): HTMLElement | null {
  const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const onscreen =
      r.width > 4 &&
      r.height > 4 &&
      r.right > 0 &&
      r.bottom > 0 &&
      r.left < window.innerWidth &&
      r.top < window.innerHeight;
    if (onscreen && el.offsetParent !== null) return el;
  }
  return null;
}

export function OnboardingWalkthrough({
  firstName,
  autoStart = false,
}: {
  firstName?: string | null;
  autoStart?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const targetElRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Move focus into the tour card on open + each step so keyboard/SR users
  // follow the walkthrough (a11y #7).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => cardRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [active, i]);

  // Auto-start for first-timers (unless the localStorage guard says a prior
  // dismissal's mark-seen may have failed) + resume the step after a mid-tour
  // reload. Manual replay (the window event below) ignores all of this.
  useEffect(() => {
    if (!autoStart) return;
    try {
      if (localStorage.getItem(LS_KEY)) return; // already seen on this device
      const saved = sessionStorage.getItem(SS_STEP);
      if (saved) {
        const n = parseInt(saved, 10);
        if (Number.isFinite(n) && n >= 0 && n < STEPS.length) setI(n);
      }
    } catch {
      /* private mode — DB flag still governs */
    }
    setActive(true);
  }, [autoStart]);

  // Replay on demand — a "Take the tour" button dispatches this.
  useEffect(() => {
    const start = () => {
      setI(0);
      setRect(null);
      setActive(true);
    };
    window.addEventListener("cc:start-tour", start);
    return () => window.removeEventListener("cc:start-tour", start);
  }, []);

  const finish = useCallback(() => {
    setActive(false);
    try {
      localStorage.setItem(LS_KEY, "1");
      sessionStorage.removeItem(SS_STEP);
    } catch {
      /* ignore */
    }
    void fetch("/api/commercial/onboarding/seen", { method: "POST" }).catch(() => undefined);
  }, []);

  // Drive the current step: navigate if needed, then find + spotlight the target.
  // Re-runs when pathname settles after a push, so the element is found once the
  // destination has rendered.
  useEffect(() => {
    if (!active) return;
    const step = STEPS[i];
    try {
      sessionStorage.setItem(SS_STEP, String(i));
    } catch {
      /* ignore */
    }
    if (step.route && pathname !== step.route) {
      router.push(step.route);
      // Wait for the pathname change to re-trigger this effect before measuring.
      return;
    }
    if (!step.target) {
      targetElRef.current = null;
      setRect(null);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const poll = () => {
      const el = findVisibleTarget(step.target!);
      if (el) {
        targetElRef.current = el;
        el.scrollIntoView({ block: "nearest" });
        setRect(el.getBoundingClientRect());
        return;
      }
      if (performance.now() - start > 2500) {
        // Target never showed (e.g. collapsed sidebar) → centered fallback.
        targetElRef.current = null;
        setRect(null);
        return;
      }
      raf = requestAnimationFrame(poll);
    };
    poll();
    return () => cancelAnimationFrame(raf);
  }, [i, active, pathname, router]);

  // Keep the spotlight glued to its element on scroll/resize.
  useEffect(() => {
    if (!active) return;
    const recompute = () => {
      if (targetElRef.current) setRect(targetElRef.current.getBoundingClientRect());
    };
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [active]);

  const go = useCallback(
    (dir: 1 | -1) => setI((n) => Math.max(0, Math.min(STEPS.length - 1, n + dir))),
    []
  );

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, finish, go]);

  if (!active) return null;

  const step = STEPS[i];
  const isLast = i === STEPS.length - 1;
  const isFirst = i === 0;
  const title = isFirst && firstName ? `Welcome, ${firstName}` : step.title;

  // Tooltip placement: to the RIGHT of the spotlight (the sidebar is on the
  // left, so there's always room); drop BELOW if the right would overflow.
  const CARD_W = 320;
  const PAD = 6;
  let cardStyle: React.CSSProperties;
  if (rect) {
    const rightX = rect.right + 14;
    if (rightX + CARD_W <= window.innerWidth - 12) {
      cardStyle = { left: rightX, top: Math.max(12, Math.min(rect.top - 4, window.innerHeight - 260)) };
    } else {
      cardStyle = {
        left: Math.max(12, Math.min(rect.left, window.innerWidth - CARD_W - 12)),
        top: rect.bottom + 14,
      };
    }
  } else {
    cardStyle = {
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
    };
  }

  const card = (
    <div
      ref={cardRef}
      tabIndex={-1}
      className="absolute w-[calc(100vw-24px)] sm:w-80 max-w-[320px] bg-surface rounded-2xl shadow-2xl overflow-hidden pointer-events-auto focus:outline-none"
      style={cardStyle}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cc-onb-title"
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const foc = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ).filter((el) => el.offsetParent !== null);
        if (foc.length === 0) return;
        const first = foc[0];
        const last = foc[foc.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }}
    >
      <div className="flex items-center justify-between px-5 pt-4">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-ppp-charcoal-400">
          {i + 1} of {STEPS.length}
        </span>
        <button
          type="button"
          onClick={finish}
          className="text-[12.5px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal px-2 py-1 min-h-[36px]"
        >
          Skip tour
        </button>
      </div>
      <div className="px-5 pb-1 pt-2">
        <h2 id="cc-onb-title" className="text-[15px] font-bold text-ppp-charcoal">
          {title}
        </h2>
        <p className="text-[13px] leading-relaxed text-ppp-charcoal-500 mt-1.5">{step.body}</p>
      </div>
      <div className="flex items-center justify-center gap-1.5 py-3.5">
        {STEPS.map((_, n) => (
          <span
            key={n}
            className={`h-1.5 rounded-full transition-all ${n === i ? "w-5 bg-cc-brand-500" : "w-1.5 bg-ppp-charcoal-200"}`}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 px-5 pb-5">
        {!isFirst && (
          <button
            type="button"
            onClick={() => go(-1)}
            className="inline-flex items-center justify-center px-4 rounded-lg border border-ppp-charcoal-200 text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={() => (isLast ? finish() : go(1))}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-cc-brand-600 text-white text-[14px] font-semibold min-h-[44px] shadow-sm hover:bg-cc-brand-700"
        >
          {isLast ? "Get started" : "Next"}
          {!isLast && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[70]">
      {/* Click-blocker — keeps the app non-interactive during the tour so the
          only way forward is the tour's own buttons. Transparent; the dark
          surround comes from the spotlight's box-shadow (or a full backdrop). */}
      <div className="absolute inset-0" aria-hidden />
      {rect ? (
        <div
          aria-hidden
          className="absolute rounded-xl ring-2 ring-cc-brand-400 transition-all duration-200 pointer-events-none"
          style={{
            left: rect.left - PAD,
            top: rect.top - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(23,43,77,0.55)",
          }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-ppp-navy-900/45 backdrop-blur-[1px]" />
      )}
      {card}
    </div>
  );
}
