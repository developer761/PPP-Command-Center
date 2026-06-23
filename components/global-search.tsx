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
  /** Extra search terms not shown in the UI (synonyms, abbreviations). */
  keywords?: string;
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

/**
 * Built-in pages — always searchable.
 *
 * `keywords` is hidden search-term enrichment: synonyms / abbreviations /
 * the words people actually type when looking for something but that
 * aren't in the visible label. Karan 2026-06-23: searching "cos"
 * (customer copy abbreviation) returned nothing because Customer Copy
 * was missing entirely and the keywords field didn't exist. Every admin
 * tool now indexed + has aliases.
 */
const PAGES: SearchResult[] = [
  // Sales Analytics
  { kind: "page", id: "p:overview", label: "Overview", sublabel: "Company dashboard", href: "/dashboard", keywords: "home main dashboard" },
  { kind: "page", id: "p:rep", label: "Rep Profiles", sublabel: "Per-rep analytics", href: "/dashboard/rep", keywords: "salesperson representative reps people" },
  { kind: "page", id: "p:map", label: "Map", sublabel: "Geographic heatmap", href: "/dashboard/map", keywords: "geographic territory heatmap" },
  // Finance & Ops
  { kind: "page", id: "p:financials", label: "Financials", sublabel: "AR, GP, discounts, commissions", href: "/dashboard/financials", keywords: "money revenue ar gp gross profit discount commission finance" },
  { kind: "page", id: "p:operations", label: "Operations", sublabel: "Labor, capacity, materials cost", href: "/dashboard/operations", keywords: "labor capacity ops" },
  // Operations Tools
  { kind: "page", id: "p:materials", label: "Materials Ordering", sublabel: "Paint + supplier orders", href: "/dashboard/materials", keywords: "paint order supplier color form gallons" },
  { kind: "page", id: "p:customers", label: "Customers", sublabel: "Customer directory + history", href: "/dashboard/customers", keywords: "customer client account history" },
  { kind: "page", id: "p:inbox", label: "Mail", sublabel: "Inbox + sent + delivery", href: "/dashboard/inbox", keywords: "email inbox sent reply bounce mail message" },
  // Admin
  { kind: "page", id: "p:integrations", label: "Integrations", sublabel: "Admin · Salesforce connection", href: "/dashboard/integrations", keywords: "salesforce sf oauth connect api integration admin" },
  { kind: "page", id: "p:settings", label: "Settings", sublabel: "Admin · all platform tools", href: "/dashboard/settings", keywords: "admin tools config configuration" },
  { kind: "page", id: "p:settings-health", label: "Setup Health", sublabel: "Admin · live status of every dependency", href: "/dashboard/settings/health", keywords: "status monitoring slack alerts env vars migrations setup health check vital" },
  { kind: "page", id: "p:settings-templates", label: "Customer Copy", sublabel: "Admin · customer-facing email + SMS templates", href: "/dashboard/settings/templates", keywords: "customer copy template email sms invite reminder confirmation message cos" },
  { kind: "page", id: "p:settings-suppliers", label: "Suppliers", sublabel: "Admin · paint suppliers + pickup locations", href: "/dashboard/settings/suppliers", keywords: "supplier vendor paint store aboffs sunbelt benjamin moore bm pickup location" },
  { kind: "page", id: "p:settings-supplier-templates", label: "Supplier Email Copy", sublabel: "Admin · per-supplier order email templates", href: "/dashboard/settings/supplier-templates", keywords: "supplier email template po purchase order copy" },
  { kind: "page", id: "p:settings-test-form", label: "Test Color Form", sublabel: "Admin · send yourself a color form to QA", href: "/dashboard/settings/test-form", keywords: "test color form qa preview link" },
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

  // Pre-lowercase a parallel "haystack" string per row so per-keystroke
  // filtering does ONE `.includes()` per row instead of 3-4 `.toLowerCase()`
  // + `.includes()` pairs. At PPP scale (20k WOs, 5k accounts), this saves
  // 60-80k temporary strings per keystroke. Recomputed only when the snapshot
  // identity changes — same snapshot ref = reused index.
  const index = useMemo(() => {
    return {
      reps: (snapshot?.reps ?? []).map((r) => ({
        row: r,
        hay: `${r.name}${r.email ?? ""}${r.region ?? ""}`.toLowerCase(),
      })),
      accounts: (snapshot?.accounts ?? []).map((a) => ({
        row: a,
        hay: `${a.name}${a.region ?? ""}`.toLowerCase(),
      })),
      workOrders: (snapshot?.workOrders ?? []).map((w) => ({
        row: w,
        // WO number + account name go in the case-insensitive hay; SF Id
        // matching stays separate below because it's case-sensitive on the
        // suffix bits.
        hay: `${w.workOrderNumber ?? ""}${w.accountName ?? ""}`.toLowerCase(),
        idLower: w.id.toLowerCase(),
      })),
      pages: PAGES.map((p) => ({
        row: p,
        // Include `keywords` (synonyms / abbreviations like "cos" → Customer
        // Copy, "sf" → Integrations) so users find pages by what they
        // actually type — not just the visible label.
        hay: `${p.label}${p.sublabel ?? ""}${p.keywords ?? ""}`.toLowerCase(),
      })),
    };
  }, [snapshot]);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PAGES.slice(0, 6);

    const matches: SearchResult[] = [];

    // Pages — bumped cap from 3 → 8 (was clipping admin tools out of
    // the result list once the settings sub-pages got indexed). 8 still
    // leaves plenty of room in the 18-row overall cap for data hits.
    let pageHitCount = 0;
    for (const { row: p, hay } of index.pages) {
      if (hay.includes(q)) {
        matches.push(p);
        pageHitCount++;
        if (pageHitCount >= 8) break;
      }
    }

    // Reps — short-circuit at 6 hits so we don't scan past the dropdown's
    // visible slot count.
    let repHitCount = 0;
    for (const { row: r, hay } of index.reps) {
      if (hay.includes(q)) {
        matches.push({
          kind: "rep",
          id: r.id,
          label: r.name,
          sublabel: r.region ?? r.email ?? "Rep",
          href: `/dashboard/rep/${r.id}`,
        });
        repHitCount++;
        if (repHitCount >= 6) break;
      }
    }

    // Accounts — short-circuit at 8.
    let acctHitCount = 0;
    for (const { row: a, hay } of index.accounts) {
      if (hay.includes(q)) {
        matches.push({
          kind: "account",
          id: a.id,
          label: a.name,
          sublabel: [a.type, a.region].filter(Boolean).join(" · ") || "Account",
          // Customer History page (built since this search shipped). Opens the
          // actual customer record instead of dumping on the rep index.
          href: `/dashboard/customer/${a.id}`,
        });
        acctHitCount++;
        if (acctHitCount >= 8) break;
      }
    }

    // Work Orders — match by WO number (human-readable), account name, OR
    // the 15/18-char Salesforce record Id. The Id match handles "I copied
    // the WO URL from Salesforce" — pasting the Id finds the same record
    // the WO number would have. 2026-06-04. Short-circuit at 6 hits.
    let woHitCount = 0;
    for (const { row: w, hay, idLower } of index.workOrders) {
      if (hay.includes(q) || (q.length >= 5 && idLower.includes(q))) {
        matches.push({
          kind: "workOrder",
          id: w.id,
          label: `WO ${w.workOrderNumber ?? w.id.slice(-6)}`,
          sublabel: [w.accountName, w.status, w.ownerName].filter(Boolean).join(" · "),
          // Open the WO's customer record when we know the account; otherwise
          // fall to Materials (where WOs are actioned), never a dead generic page.
          href: w.accountId ? `/dashboard/customer/${w.accountId}` : "/dashboard/materials",
        });
        woHitCount++;
        if (woHitCount >= 6) break;
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
            className="w-full pl-9 pr-3 py-2 text-base sm:text-sm bg-white border border-ppp-blue-200 rounded-lg placeholder:text-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-ppp-blue-100"
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
