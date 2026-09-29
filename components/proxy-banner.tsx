"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The bar across the top of every page while an admin is logged in AS somebody
 * else (Katie, 2026-09-29).
 *
 * Loud on purpose, and it carries the way out. A proxy is not a filter — every
 * click is being made inside another person's account, with their permissions,
 * and the one unforgivable version of this feature is the one somebody forgets
 * they are in. Salesforce puts the same bar in the same place for the same
 * reason.
 *
 * It sits ABOVE the "View As" banner in the tree and reads differently on
 * purpose: View As narrows what you can see, this replaces who you are.
 *
 * The colors are the View As banner's, deliberately — orange-700 with
 * orange-50 text, which the contrast test already vouches for in both themes.
 * White on the brand orange is 3.19:1 and fails AA; orange-700 inverts in dark
 * and fails there. Loud still has to be readable.
 */
export default function ProxyBanner({
  actingAs,
  realEmail,
}: {
  actingAs: string;
  realEmail: string;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function stop() {
    setLeaving(true);
    try {
      await fetch("/api/admin/proxy", { method: "DELETE" });
      // A full reload, not router.refresh(): every server component on the
      // page was rendered as the other person, and so was the shell around
      // them. Refreshing in place leaves their menus on screen.
      window.location.assign("/dashboard");
    } catch {
      setLeaving(false);
    }
  }

  return (
    <div
      role="status"
      className="sticky top-0 z-50 bg-ppp-orange-700 text-ppp-orange-50 px-4 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-3 flex-wrap shadow-sm"
    >
      <span className="text-sm font-medium min-w-0">
        <span className="font-bold">Logged in as {actingAs}.</span>{" "}
        <span className="opacity-90">
          You are seeing exactly what they see. Signed in as {realEmail}.
        </span>
      </span>
      <button
        type="button"
        onClick={stop}
        disabled={leaving}
        className="shrink-0 inline-flex items-center gap-1 px-3 py-2 sm:py-1.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 font-semibold text-sm transition-colors disabled:opacity-60 min-h-[44px] sm:min-h-0 touch-manipulation"
      >
        {leaving ? "Returning…" : "Return to my account"}
      </button>
    </div>
  );
}
