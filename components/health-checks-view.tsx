"use client";

/**
 * Health Checks View — shared component rendered on BOTH:
 *   - /dashboard/settings/health   (PPP CC, hits /api/admin/health)
 *   - /commercial/settings/health  (Commercial CC, hits
 *                                   /api/admin/commercial-health)
 *
 * Driven by props so each side passes its own endpoint + group meta.
 * The two pages stay in visual lockstep — change this component, both
 * pages update.
 *
 * Behavior:
 *   - Initial fetch on mount + auto-refresh every 30s (skip when tab
 *     not visible, resume on focus — mobile-friendly + battery-friendly)
 *   - Status badge per check (ok / warn / fail) with both color AND
 *     icon AND word so colorblind admins can read it
 *   - Optional "Test Slack" button — clicked, posts to
 *     /api/admin/test-slack-webhook, surfaces the response inline
 *   - Mobile: 44px tap targets on every button, full-width rows,
 *     details expand-on-tap instead of hover
 *   - Detail rows can be expanded for the full message — keeps the
 *     glance view scannable while letting admins drill in
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

export type HealthCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  message: string;
  group?: string;
  fix?: string;
};

export type Summary = { ok: number; warn: number; fail: number; total: number };

export type GroupMeta = Record<string, { heading: string; subhead: string }>;

const AUTO_REFRESH_MS = 30_000;

export default function HealthChecksView({
  endpoint,
  groupMeta,
  showSlackTest = false,
}: {
  endpoint: string;
  groupMeta: GroupMeta;
  /** When true, renders a "Send test alert" button alongside the
   *  Re-run button. Only meaningful on the Commercial CC page today
   *  (PPP CC may opt in once it wires observability for its own
   *  surfaces). */
  showSlackTest?: boolean;
}) {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [slackTestState, setSlackTestState] = useState<
    "idle" | "sending" | { ok: boolean; detail: string }
  >("idle");
  // Track the previous response so an interim refresh doesn't blank
  // the page when nothing meaningful changed.
  const lastGoodChecksRef = useRef<HealthCheck[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      const newChecks = data.checks as HealthCheck[];
      setChecks(newChecks);
      lastGoodChecksRef.current = newChecks;
      setSummary(data.summary as Summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh while tab is visible. Pauses when tab is backgrounded
  // (battery-friendly on mobile). Resumes on focus + refetches
  // immediately so admin sees fresh state on return.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === "visible") void load();
      }, AUTO_REFRESH_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", load);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  const sendSlackTest = useCallback(async () => {
    setSlackTestState("sending");
    try {
      const res = await fetch("/api/admin/test-slack-webhook", { method: "POST" });
      const data = await res.json();
      setSlackTestState({
        ok: !!data.ok,
        detail: data.detail ?? data.error ?? "no detail",
      });
    } catch (err) {
      setSlackTestState({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // First paint: show skeleton when truly no data yet. After the first
  // load, never blank — keep stale data visible during refresh.
  if (loading && !checks && !lastGoodChecksRef.current) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-16 rounded-xl bg-ppp-charcoal-50" />
        ))}
      </div>
    );
  }

  if (error && !checks) {
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-700 flex items-center justify-between gap-3">
        <span>Couldn&apos;t run health checks: {error}</span>
        <button
          type="button"
          onClick={load}
          className="px-3 py-1.5 rounded-md border border-rose-200 bg-white text-xs font-medium text-rose-700 hover:bg-rose-100 transition-colors touch-manipulation min-h-[44px]"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!checks || !summary) return null;

  const allGreen = summary.fail === 0 && summary.warn === 0;
  const groupKeys = Object.keys(groupMeta);

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Summary banner — color + icon + word so it's accessible */}
      <div
        className={`rounded-xl border px-4 py-3 text-sm flex items-center justify-between gap-3 flex-wrap ${
          summary.fail > 0
            ? "bg-rose-50 border-rose-200 text-rose-800 font-semibold"
            : summary.warn > 0
              ? "bg-amber-50 border-amber-200 text-amber-800"
              : "bg-emerald-50 border-emerald-200 text-emerald-800"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge
            status={summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "ok"}
            large
          />
          <span>
            {allGreen
              ? `All ${summary.total} checks passing.`
              : `${summary.ok}/${summary.total} OK · ${summary.warn} warn${summary.warn === 1 ? "" : "s"}${summary.fail > 0 ? ` · ${summary.fail} fail` : ""}`}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {showSlackTest && (
            <button
              type="button"
              onClick={sendSlackTest}
              disabled={slackTestState === "sending"}
              className="px-3 py-1.5 rounded-md border border-current text-xs font-medium hover:bg-white/40 transition-colors disabled:opacity-50 touch-manipulation min-h-[44px]"
            >
              {slackTestState === "sending" ? "Sending…" : "Send test Slack alert"}
            </button>
          )}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 rounded-md border border-current text-xs font-medium hover:bg-white/40 transition-colors disabled:opacity-50 touch-manipulation min-h-[44px]"
          >
            {loading ? "Checking…" : "Re-run"}
          </button>
        </div>
      </div>

      {/* Slack-test result banner — only renders after a test */}
      {typeof slackTestState === "object" && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            slackTestState.ok
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-amber-50 border-amber-200 text-amber-800"
          }`}
        >
          {slackTestState.ok ? "✓ " : "⚠ "}
          {slackTestState.detail}
        </div>
      )}

      {/* Grouped checks — order follows props (caller's groupMeta).
          Each group hides itself when empty so a single-bucket health
          page doesn't render a lone heading. */}
      {groupKeys.map((groupKey) => {
        const groupChecks = checks.filter((c) => (c.group ?? groupKeys[0]) === groupKey);
        if (groupChecks.length === 0) return null;
        const meta = groupMeta[groupKey];
        return (
          <section key={groupKey} className="space-y-2">
            <div>
              <h2 className="text-xs uppercase tracking-[0.18em] text-ppp-charcoal-500 font-bold">
                {meta.heading}
              </h2>
              <p className="text-[11px] text-ppp-charcoal-400 mt-0.5">{meta.subhead}</p>
            </div>
            <ul className="space-y-2">
              {groupChecks.map((c) => {
                const isExpanded = expandedId === c.id;
                return (
                  <li
                    key={c.id}
                    className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : c.id)}
                      className="block w-full text-left px-4 py-3 hover:bg-ppp-charcoal-50/40 active:bg-ppp-charcoal-50 transition-colors touch-manipulation min-h-[44px]"
                    >
                      <div className="flex items-start gap-3">
                        <StatusBadge status={c.status} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-ppp-charcoal">
                            {c.label}
                          </div>
                          <p
                            className={`text-[11px] text-ppp-charcoal-500 mt-1 leading-snug ${
                              isExpanded ? "" : "line-clamp-2"
                            }`}
                          >
                            {c.message}
                          </p>
                          {isExpanded && c.fix && c.status !== "ok" && (
                            <div className="mt-2">
                              {c.fix.startsWith("/dashboard/") ||
                              c.fix.startsWith("/commercial/") ? (
                                <Link
                                  href={c.fix}
                                  className="inline-flex items-center text-[11px] font-semibold text-ppp-blue-700 hover:text-ppp-blue-800 hover:underline min-h-[32px] touch-manipulation"
                                >
                                  Fix it →
                                </Link>
                              ) : (
                                <p className="text-[11px] font-medium text-ppp-charcoal-600 italic">
                                  How to fix: {c.fix}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                        <span
                          className="text-[11px] text-ppp-charcoal-400 shrink-0 mt-0.5"
                          aria-hidden
                        >
                          {isExpanded ? "−" : "+"}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Status badge — color + icon + word so colorblind admins can read
 *  it. Word is hidden on the largest screens (where the icon + color
 *  is plenty) but always rendered for screen readers via sr-only. */
function StatusBadge({
  status,
  large = false,
}: {
  status: "ok" | "warn" | "fail";
  large?: boolean;
}) {
  const cls =
    status === "ok"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : status === "warn"
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : "bg-rose-100 text-rose-800 border-rose-300 ring-1 ring-rose-200";
  const glyph = status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
  const word = status === "ok" ? "OK" : status === "warn" ? "warn" : "fail";
  return (
    <span
      className={`inline-flex items-center justify-center font-bold border rounded-full shrink-0 ${cls} ${
        large
          ? "h-7 px-2 text-[11px]"
          : "h-6 w-6 text-[10px]"
      }`}
      title={`Status: ${word}`}
    >
      <span aria-hidden>{glyph}</span>
      <span className="sr-only">{word}</span>
      {large && <span className="ml-1 not-sr-only">{word}</span>}
    </span>
  );
}
