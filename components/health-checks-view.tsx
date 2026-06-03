"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type HealthCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  message: string;
  /** Visual grouping: "platform" = env vars + db migrations (infra config),
   *  "data" = Salesforce + supplier data quality (PPP-side fixes). Undefined
   *  defaults to "platform" so older check shapes still render. */
  group?: "platform" | "data";
  fix?: string;
};

const GROUP_META: Record<"platform" | "data", { heading: string; subhead: string }> = {
  platform: {
    heading: "Platform setup",
    subhead: "Environment variables + database migrations the platform needs to run end-to-end.",
  },
  data: {
    heading: "Salesforce data quality",
    subhead: "PPP-side data that the platform reads — things to fix in Salesforce or in supplier settings.",
  },
};

type Summary = { ok: number; warn: number; fail: number; total: number };

export default function HealthChecksView() {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/health");
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      setChecks(data.checks as HealthCheck[]);
      setSummary(data.summary as Summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading && !checks) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-16 rounded-xl bg-ppp-charcoal-50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl p-4 text-sm text-ppp-orange-700 flex items-center justify-between gap-3">
        <span>Couldn&apos;t run health checks: {error}</span>
        <button
          type="button"
          onClick={load}
          className="px-3 py-1.5 rounded-md border border-ppp-orange-200 bg-white text-xs font-medium text-ppp-orange-700 hover:bg-ppp-orange-100 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!checks || !summary) return null;

  const allGreen = summary.fail === 0 && summary.warn === 0;

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Summary banner — green when all clear, escalating tones otherwise */}
      <div
        className={`rounded-xl border px-4 py-3 text-sm flex items-center justify-between gap-3 ${
          summary.fail > 0
            ? "bg-ppp-orange-100 border-ppp-orange-200 text-ppp-orange-700 font-semibold"
            : summary.warn > 0
            ? "bg-ppp-orange-50 border-ppp-orange-100 text-ppp-orange-700"
            : "bg-ppp-green-50 border-ppp-green-100 text-ppp-green-700"
        }`}
      >
        <div className="flex items-center gap-2">
          <StatusBadge status={summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "ok"} large />
          <span>
            {allGreen
              ? `All ${summary.total} checks passing. Platform is wired up.`
              : `${summary.ok}/${summary.total} checks passing · ${summary.warn} warning${summary.warn === 1 ? "" : "s"}${summary.fail > 0 ? ` · ${summary.fail} critical` : ""}`}
          </span>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 rounded-md border border-current text-xs font-medium hover:bg-white/40 transition-colors disabled:opacity-50"
        >
          {loading ? "Checking…" : "Re-run"}
        </button>
      </div>

      {/* Grouped checks — "Platform setup" first, then "Salesforce data quality".
          Each group hides itself when empty so a single-bucket health page
          doesn't render a lone heading. */}
      {(["platform", "data"] as const).map((group) => {
        const groupChecks = checks.filter((c) => (c.group ?? "platform") === group);
        if (groupChecks.length === 0) return null;
        const meta = GROUP_META[group];
        return (
          <section key={group} className="space-y-2">
            <div>
              <h2 className="text-xs font-condensed uppercase tracking-[0.18em] text-ppp-charcoal-500 font-bold">
                {meta.heading}
              </h2>
              <p className="text-[11px] text-ppp-charcoal-400 mt-0.5">{meta.subhead}</p>
            </div>
            <ul className="space-y-2">
              {groupChecks.map((c) => (
                <li
                  key={c.id}
                  className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3"
                >
                  <div className="flex items-start gap-3">
                    <StatusBadge status={c.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-ppp-charcoal">{c.label}</div>
                      <p className="text-[11px] text-ppp-charcoal-500 mt-1 leading-snug">
                        {c.message}
                      </p>
                      {c.fix && c.status !== "ok" && (
                        <div className="mt-2">
                          {c.fix.startsWith("/dashboard/") ? (
                            <Link
                              href={c.fix}
                              className="inline-flex items-center text-[11px] font-semibold text-ppp-blue-700 hover:text-ppp-blue-800 hover:underline"
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
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function StatusBadge({ status, large = false }: { status: "ok" | "warn" | "fail"; large?: boolean }) {
  const cls =
    status === "ok"
      ? "bg-ppp-green-100 text-ppp-green-700"
      : status === "warn"
      ? "bg-ppp-orange-100 text-ppp-orange-700"
      : "bg-ppp-orange-200 text-ppp-orange-800";
  const icon = status === "ok" ? "✓" : status === "warn" ? "!" : "×";
  const size = large ? "h-6 w-6 text-sm" : "h-5 w-5 text-[11px]";
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold shrink-0 ${size} ${cls}`}
      aria-label={status === "ok" ? "Passing" : status === "warn" ? "Warning" : "Critical"}
    >
      {icon}
    </span>
  );
}
