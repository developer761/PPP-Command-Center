"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type SearchResult = {
  kind: "rep" | "account" | "workOrder" | "page";
  id: string;
  label: string;
  sublabel?: string;
  href: string;
};

type SearchableSnapshot = {
  reps?: Array<{ id: string; name: string; email?: string | null; region?: string | null }>;
  accounts?: Array<{ id: string; name: string; type?: string | null; region?: string | null }>;
  workOrders?: Array<{
    id: string;
    workOrderNumber: string | null;
    accountId?: string | null;
    accountName: string | null;
    status: string | null;
    ownerName: string | null;
    opportunityId: string | null;
  }>;
};

/** Built-in pages — always searchable. */
const PAGES: SearchResult[] = [
  { kind: "page", id: "p:overview", label: "Overview", sublabel: "Company dashboard", href: "/dashboard" },
  { kind: "page", id: "p:rep", label: "Rep Profiles", sublabel: "Per-rep analytics", href: "/dashboard/rep" },
  { kind: "page", id: "p:customers", label: "Customers", sublabel: "Customer directory + history", href: "/dashboard/customers" },
  { kind: "page", id: "p:inbox", label: "Mail", sublabel: "Inbox + sent + delivery", href: "/dashboard/inbox" },
  { kind: "page", id: "p:financials", label: "Financials", sublabel: "AR, GP, discounts, commissions", href: "/dashboard/financials" },
  { kind: "page", id: "p:operations", label: "Operations", sublabel: "Labor, capacity, materials cost", href: "/dashboard/operations" },
  { kind: "page", id: "p:map", label: "Map", sublabel: "Geographic heatmap", href: "/dashboard/map" },
  { kind: "page", id: "p:materials", label: "Materials Ordering", sublabel: "Phase 2", href: "/dashboard/materials" },
  { kind: "page", id: "p:integrations", label: "Integrations", sublabel: "Admin · Salesforce connection", href: "/dashboard/integrations" },
];

type Props = {
  /**
   * Optional initial snapshot. If null, the search bar lazy-fetches from
   * /api/search/index on first focus to keep the dashboard chrome fast.
   */
  snapshot?: SearchableSnapshot | null;
};

export default function GlobalSearch({ snapshot: initial = null }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [snapshot, setSnapshot] = useState<SearchableSnapshot | null>(initial);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Lazy-fetch the search index on first focus. Caches in component state
  // so subsequent opens don't re-fetch.
  const loadIndex = async () => {
    if (snapshot || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/search/index");
      if (res.ok) {
        const data = await res.json();
        setSnapshot(data);
      }
    } catch {
      // graceful — pages still searchable, just not data
    } finally {
      setLoading(false);
    }
  };

  // Cmd+K / Ctrl+K to focus search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
        void loadIndex();
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Click outside to close
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", onClick);
      return () => document.removeEventListener("mousedown", onClick);
    }
  }, [open]);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PAGES.slice(0, 6);

    const matches: SearchResult[] = [];

    // Pages (always low limit so they don't crowd out data)
    for (const p of PAGES) {
      if (p.label.toLowerCase().includes(q) || p.sublabel?.toLowerCase().includes(q)) {
        matches.push(p);
        if (matches.filter((m) => m.kind === "page").length >= 3) break;
      }
    }

    // Reps
    if (snapshot?.reps) {
      const repHits = snapshot.reps
        .filter((r) =>
          r.name.toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q) ||
          (r.region ?? "").toLowerCase().includes(q)
        )
        .slice(0, 6);
      for (const r of repHits) {
        matches.push({
          kind: "rep",
          id: r.id,
          label: r.name,
          sublabel: r.region ?? r.email ?? "Rep",
          href: `/dashboard/rep/${r.id}`,
        });
      }
    }

    // Accounts
    if (snapshot?.accounts) {
      const acctHits = snapshot.accounts
        .filter((a) =>
          a.name.toLowerCase().includes(q) ||
          (a.region ?? "").toLowerCase().includes(q)
        )
        .slice(0, 8);
      for (const a of acctHits) {
        matches.push({
          kind: "account",
          id: a.id,
          label: a.name,
          sublabel: [a.type, a.region].filter(Boolean).join(" · ") || "Account",
          // Customer History page (built since this search shipped). Opens the
          // actual customer record instead of dumping on the rep index.
          href: `/dashboard/customer/${a.id}`,
        });
      }
    }

    // Work Orders (by number)
    if (snapshot?.workOrders) {
      const woHits = snapshot.workOrders
        .filter((w) =>
          (w.workOrderNumber ?? "").toLowerCase().includes(q) ||
          (w.accountName ?? "").toLowerCase().includes(q)
        )
        .slice(0, 6);
      for (const w of woHits) {
        matches.push({
          kind: "workOrder",
          id: w.id,
          label: `WO ${w.workOrderNumber ?? w.id.slice(-6)}`,
          sublabel: [w.accountName, w.status, w.ownerName].filter(Boolean).join(" · "),
          // Open the WO's customer record when we know the account; otherwise
          // fall to Materials (where WOs are actioned), never a dead generic page.
          href: w.accountId ? `/dashboard/customer/${w.accountId}` : "/dashboard/materials",
        });
      }
    }

    return matches.slice(0, 18);
  }, [query, snapshot]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // No-op when there are no results — without this guard, activeIdx
      // could end up at -1 and Enter would crash on results[-1].
      if (results.length === 0) return;
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results.length === 0) return;
      const safeIdx = Math.min(Math.max(activeIdx, 0), results.length - 1);
      const r = results[safeIdx];
      if (r) {
        router.push(r.href);
        setOpen(false);
        setQuery("");
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <div className="relative flex-1 max-w-xl" ref={wrapperRef}>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            void loadIndex();
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-ppp-charcoal-500 bg-ppp-charcoal-50/60 hover:bg-ppp-charcoal-50 border border-ppp-charcoal-100 rounded-lg transition-colors"
        >
          <IconSearch />
          <span className="hidden sm:inline truncate">Search reps, customers, work orders…</span>
          <span className="sm:hidden truncate">Search…</span>
          <kbd className="ml-auto hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono bg-white border border-ppp-charcoal-100 rounded text-ppp-charcoal-500">
            ⌘K
          </kbd>
        </button>
      ) : (
        <div className="relative">
          <span className="absolute inset-y-0 left-3 flex items-center text-ppp-charcoal-300 pointer-events-none">
            <IconSearch />
          </span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-ppp-blue-200 rounded-lg placeholder:text-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-ppp-blue-100"
          />
          {(results.length > 0 || query) && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-ppp-charcoal-100 rounded-lg shadow-lg shadow-ppp-charcoal/10 max-h-[60vh] overflow-y-auto z-50">
              {loading && !snapshot ? (
                <div className="px-4 py-6 text-center text-xs text-ppp-charcoal-500">
                  Loading search index…
                </div>
              ) : results.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-ppp-charcoal-500">
                  No matches for &ldquo;{query}&rdquo;
                </div>
              ) : (
                <ul className="py-1">
                  {results.map((r, i) => (
                    <li key={r.id}>
                      <Link
                        href={r.href}
                        onClick={() => {
                          setOpen(false);
                          setQuery("");
                        }}
                        className={[
                          "flex items-center gap-3 px-3 py-2 text-sm transition-colors",
                          i === activeIdx
                            ? "bg-ppp-blue-50 text-ppp-blue-700"
                            : "hover:bg-ppp-charcoal-50/60 text-ppp-charcoal",
                        ].join(" ")}
                      >
                        <KindBadge kind={r.kind} />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{r.label}</div>
                          {r.sublabel && (
                            <div className="text-[10px] text-ppp-charcoal-500 truncate">
                              {r.sublabel}
                            </div>
                          )}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-ppp-charcoal-100 px-3 py-1.5 text-[10px] text-ppp-charcoal-500 flex items-center gap-3">
                <kbd className="px-1 py-0 bg-ppp-charcoal-50 rounded">↑↓</kbd> nav
                <kbd className="px-1 py-0 bg-ppp-charcoal-50 rounded">↵</kbd> open
                <kbd className="px-1 py-0 bg-ppp-charcoal-50 rounded">esc</kbd> close
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: SearchResult["kind"] }) {
  const cfg = {
    rep: { bg: "bg-ppp-blue-50", fg: "text-ppp-blue-700", label: "Rep" },
    account: { bg: "bg-ppp-green-50", fg: "text-ppp-green-700", label: "Acct" },
    workOrder: { bg: "bg-ppp-orange-50", fg: "text-ppp-orange-700", label: "WO" },
    page: { bg: "bg-ppp-charcoal-50", fg: "text-ppp-charcoal-500", label: "Page" },
  }[kind];
  return (
    <span
      className={`inline-flex items-center justify-center px-1.5 py-0 rounded text-[9px] font-bold uppercase tracking-wide ${cfg.bg} ${cfg.fg} shrink-0 w-10`}
    >
      {cfg.label}
    </span>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
