"use client";

import { useState } from "react";
import Image from "next/image";
import { PLATFORM_SET_ROUTE, type Platform } from "@/lib/platform-cookie";

/**
 * Post-login platform picker (only rendered for multi-access users).
 *
 * Two big cards side-by-side. Click → POST /api/platform/set → server
 * sets cookie + returns redirect target → client navigates.
 *
 * The page-level Server Component above already redirects single-access
 * users to their only platform, so this component never has to deal with
 * "which one is accessible." Both are.
 */
export default function PlatformPicker({ email }: { email: string }) {
  const [busy, setBusy] = useState<Platform | null>(null);

  const choose = async (platform: Platform) => {
    if (busy) return;
    setBusy(platform);
    try {
      const res = await fetch(PLATFORM_SET_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      if (!res.ok) {
        setBusy(null);
        return;
      }
      const data = (await res.json()) as { redirect?: string };
      window.location.href = data.redirect ?? "/dashboard";
    } catch {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen bg-ppp-charcoal-50 flex flex-col">
      <header className="border-b border-ppp-charcoal-100 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Image src="/brand/logo.svg" alt="Precision Painting Plus" width={160} height={48} priority />
          <div className="text-sm text-ppp-charcoal-500">{email}</div>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-4xl">
          <div className="text-center mb-10">
            <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal">Where to today?</h1>
            <p className="mt-2 text-sm text-ppp-charcoal-500">
              You have access to both platforms. Pick one to start — you can switch from the sidebar anytime.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Command Center */}
            <button
              type="button"
              onClick={() => choose("command_center")}
              disabled={busy !== null}
              className={[
                "group relative text-left rounded-xl border-2 bg-white p-6 transition-all",
                "border-ppp-charcoal-100 hover:border-ppp-blue hover:shadow-lg",
                busy === "command_center" ? "ring-2 ring-ppp-blue ring-offset-2" : "",
                busy && busy !== "command_center" ? "opacity-60" : "",
              ].join(" ")}
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="h-12 w-12 rounded-lg bg-ppp-blue-50 flex items-center justify-center text-ppp-blue">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 9.5L12 3l9 6.5V21H3z M9 21V12h6v9" />
                  </svg>
                </div>
                <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-ppp-green bg-ppp-green-50 px-2 py-0.5 rounded">
                  Live
                </span>
              </div>
              <h2 className="text-lg font-bold text-ppp-charcoal mb-1">Command Center</h2>
              <p className="text-sm text-ppp-charcoal-500 leading-relaxed">
                Residential sales, customer color forms, materials ordering, Mail Hub, scorecards. Salesforce-mirrored data.
              </p>
              <div className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-ppp-blue group-hover:gap-2 transition-all">
                {busy === "command_center" ? "Loading…" : "Open"}
                {busy !== "command_center" && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12h14 M13 5l7 7-7 7" />
                  </svg>
                )}
              </div>
            </button>

            {/* New Platform */}
            <button
              type="button"
              onClick={() => choose("new_platform")}
              disabled={busy !== null}
              className={[
                "group relative text-left rounded-xl border-2 bg-white p-6 transition-all",
                "border-ppp-charcoal-100 hover:border-emerald-600 hover:shadow-lg",
                busy === "new_platform" ? "ring-2 ring-emerald-600 ring-offset-2" : "",
                busy && busy !== "new_platform" ? "opacity-60" : "",
              ].join(" ")}
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="h-12 w-12 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-700">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M2 22h20 M3 22V11l9-7 9 7v11 M9 22v-6h6v6" />
                  </svg>
                </div>
                <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                  Phase 0
                </span>
              </div>
              <h2 className="text-lg font-bold text-ppp-charcoal mb-1">New Platform</h2>
              <p className="text-sm text-ppp-charcoal-500 leading-relaxed">
                Commercial bidding + project lifecycle (9 phases: account → opportunity → estimating → contract → execution → close).
                Postgres-native, in early build.
              </p>
              <div className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-emerald-700 group-hover:gap-2 transition-all">
                {busy === "new_platform" ? "Loading…" : "Open"}
                {busy !== "new_platform" && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12h14 M13 5l7 7-7 7" />
                  </svg>
                )}
              </div>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
