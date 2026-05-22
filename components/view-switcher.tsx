"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useViewer } from "@/lib/auth/viewer-context";

type RepOption = { id: string; name: string };

/**
 * Admin-only UI in the topbar. Two pieces:
 *
 * 1. All / My toggle — admin's own scope (`?scope=all` or `?scope=my`)
 * 2. View As [rep] dropdown — impersonate a specific rep (`?view_as=<sfId>`)
 *
 * State lives in the URL so refreshes + shared links preserve the view, and
 * every admin's impersonation lands in view_as_audit (forever audit log).
 *
 * Non-admins see nothing (we render `null`).
 */
type Props = {
  reps?: RepOption[];
};

// Module-scope cache so the dropdown opens instantly after the first fetch.
let cachedReps: RepOption[] | null = null;

export default function ViewSwitcher({ reps: propReps = [] }: Props) {
  const viewer = useViewer();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [fetched, setFetched] = useState<RepOption[] | null>(cachedReps);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Lazy-load the rep list on first open. We don't want the dashboard layout
  // to await this just to render chrome.
  useEffect(() => {
    if (!open || cachedReps || !viewer?.isAdmin) return;
    let cancelled = false;
    fetch("/api/admin/reps", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list: RepOption[] = Array.isArray(data?.reps)
          ? data.reps
              .map((r: { id?: unknown; name?: unknown }) => ({
                id: typeof r.id === "string" ? r.id : "",
                name: typeof r.name === "string" ? r.name : "",
              }))
              .filter((r: RepOption) => r.id && r.name)
              .sort((a: RepOption, b: RepOption) => a.name.localeCompare(b.name))
          : [];
        cachedReps = list;
        setFetched(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, viewer?.isAdmin]);

  const reps: RepOption[] = fetched ?? (propReps.length ? propReps : []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reps.slice(0, 50);
    return reps.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 50);
  }, [reps, query]);

  if (!viewer || !viewer.isAdmin) return null;

  const navigate = (next: URLSearchParams) => {
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const setScope = (scope: "all" | "my") => {
    const next = new URLSearchParams(params.toString());
    next.delete("view_as");
    if (scope === "my") next.set("scope", "my");
    else next.delete("scope");
    navigate(next);
  };

  const pickRep = (sfId: string, _name: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("view_as", sfId);
    next.delete("scope");
    navigate(next);
    setOpen(false);
    setQuery("");
  };

  const clearViewAs = () => {
    const next = new URLSearchParams(params.toString());
    next.delete("view_as");
    next.delete("scope");
    navigate(next);
    setOpen(false);
    setQuery("");
  };

  const impersonating = !!viewer.viewAsUserId;
  const activeRep = impersonating
    ? reps.find((r) => r.id === viewer.viewAsUserId) ?? null
    : null;
  const activeLabel = impersonating
    ? activeRep?.name ?? viewer.viewAsName ?? "Selected rep"
    : viewer.scope === "all"
      ? "All reps"
      : "My data";

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1">
      {/* All / My toggle */}
      {!impersonating && (
        <div className="hidden sm:flex items-center rounded-full border border-ppp-charcoal-100 bg-white p-0.5">
          <button
            type="button"
            onClick={() => setScope("all")}
            className={[
              "px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors",
              viewer.scope === "all"
                ? "bg-ppp-blue text-white shadow-sm"
                : "text-ppp-charcoal-500 hover:text-ppp-charcoal",
            ].join(" ")}
            aria-pressed={viewer.scope === "all"}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setScope("my")}
            disabled={!viewer.sfUserId}
            className={[
              "px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors",
              viewer.scope === "my"
                ? "bg-ppp-blue text-white shadow-sm"
                : "text-ppp-charcoal-500 hover:text-ppp-charcoal",
              !viewer.sfUserId ? "opacity-40 cursor-not-allowed" : "",
            ].join(" ")}
            aria-pressed={viewer.scope === "my"}
            title={
              viewer.sfUserId
                ? "Show only the data you own"
                : "You don't have a Salesforce rep account — admin-only view"
            }
          >
            My
          </button>
        </div>
      )}

      {/* View As button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-medium transition-colors",
          impersonating
            ? "border-ppp-orange-200 bg-ppp-orange-50 text-ppp-orange-700 hover:bg-ppp-orange-100"
            : "border-ppp-charcoal-100 bg-white text-ppp-charcoal hover:bg-ppp-blue-50 hover:border-ppp-blue-200",
        ].join(" ")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {impersonating ? (
          <span className="h-1.5 w-1.5 rounded-full bg-ppp-orange animate-pulse" aria-hidden />
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        )}
        <span className="truncate max-w-[140px]">
          {impersonating ? `Viewing as ${activeLabel}` : activeLabel}
        </span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 max-w-[90vw] bg-white border border-ppp-charcoal-100 rounded-xl shadow-xl shadow-ppp-charcoal/10 z-50 overflow-hidden animate-fade-in">
          <div className="p-2 border-b border-ppp-charcoal-100">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search reps…"
              className="w-full px-3 py-1.5 text-[12px] border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
              autoFocus
            />
          </div>
          <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
            {impersonating && (
              <li>
                <button
                  type="button"
                  onClick={clearViewAs}
                  className="w-full text-left px-3 py-2 text-[12px] text-ppp-orange-700 font-medium hover:bg-ppp-orange-50"
                >
                  ← Stop viewing as {activeLabel}
                </button>
              </li>
            )}
            {filtered.length === 0 && (
              <li className="px-3 py-3 text-[12px] text-ppp-charcoal-500">No reps match.</li>
            )}
            {filtered.map((r) => {
              const active = viewer.viewAsUserId === r.id;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => pickRep(r.id, r.name)}
                    className={[
                      "w-full text-left px-3 py-2 text-[12px] transition-colors",
                      active
                        ? "bg-ppp-blue-50 text-ppp-blue-700 font-medium"
                        : "text-ppp-charcoal hover:bg-ppp-blue-50/60",
                    ].join(" ")}
                  >
                    {r.name}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="px-3 py-2 text-[10px] text-ppp-charcoal-400 border-t border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
            View-as actions are logged for audit.
          </div>
        </div>
      )}
    </div>
  );
}
