"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useViewer } from "@/lib/auth/viewer-context";

/** Shared module-scope cache with ViewSwitcher would be cleanest, but a
 * second fetch here is cheap and avoids cross-file coupling. */
let cachedReps: Array<{ id: string; name: string }> | null = null;

type Props = {
  reps?: Array<{ id: string; name: string }>;
};

/**
 * Bright, persistent banner shown whenever an admin is impersonating a rep.
 * Without it, the View Switcher chip in the topbar is easy to miss — an
 * admin could report numbers as their own that are actually scoped to Bob.
 */
export default function ImpersonationBanner({ reps = [] }: Props) {
  const viewer = useViewer();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [fetched, setFetched] = useState(cachedReps);
  const [isPending, startTransition] = useTransition();

  const impersonating = !!viewer?.isAdmin && !!viewer.viewAsUserId;

  // Lazy-resolve the rep name when admin lands on a page with ?view_as= set
  // but no in-prop reps list (e.g., page refresh while impersonating).
  useEffect(() => {
    if (!impersonating || cachedReps) return;
    let cancelled = false;
    fetch("/api/admin/reps", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.reps) ? data.reps : [];
        cachedReps = list;
        setFetched(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [impersonating]);

  if (!impersonating) return null;

  const directory = reps.length ? reps : fetched ?? [];
  const target = directory.find((r) => r.id === viewer!.viewAsUserId);
  const targetName = target?.name ?? viewer!.viewAsName ?? "selected rep";

  const exit = () => {
    const next = new URLSearchParams(params.toString());
    next.delete("view_as");
    next.delete("scope");
    const qs = next.toString();
    // Hard navigation to /dashboard (admin's natural "home"). Avoids the
    // ~1-2s React tree rebuild from router.push() when the snapshot
    // re-scopes mid-page. With window.location, the browser cache + Next
    // RSC stream make this feel instant on every screen.
    if (typeof window !== "undefined") {
      window.location.href = qs ? `${pathname}?${qs}` : pathname;
      return;
    }
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  };

  return (
    <div className="bg-ppp-orange text-white px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between gap-3 text-[12px] sm:text-[13px]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="h-2 w-2 rounded-full bg-white animate-pulse shrink-0" aria-hidden />
        <span className="truncate">
          <span className="font-semibold">Viewing as {targetName}</span>
          <span className="hidden sm:inline opacity-90"> · numbers reflect this rep&apos;s data only. Audit logged.</span>
        </span>
      </div>
      <button
        type="button"
        onClick={exit}
        disabled={isPending}
        className="shrink-0 inline-flex items-center gap-1 px-3 py-2 sm:py-1 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium transition-colors disabled:opacity-60"
      >
        {isPending ? "Exiting…" : "Exit"}
      </button>
    </div>
  );
}
