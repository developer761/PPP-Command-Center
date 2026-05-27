"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Per-supplier email templates editor. Sibling to the customer-form
 * templates editor at /dashboard/settings/templates but scoped per supplier
 * (BM gets different copy than SW, etc.). NULL fields fall back to the
 * code-level DEFAULT_SUPPLIER_TEMPLATE.
 *
 * UX flow:
 *   1. List view — every supplier in the snapshot with "Custom" / "Default"
 *      pills + colors-in-catalog count (most-used supplier first)
 *   2. Click a supplier → expand inline editor with the 5 fields (subject,
 *      greeting, intro, outro, signoff) + variable reference + reset-each
 *   3. Save → POST /api/admin/supplier-templates with the patch
 *   4. List refreshes so the "Custom" pill appears
 */

type Template = {
  subject: string;
  greeting: string;
  intro: string;
  outro: string;
  signoff: string;
};

type SupplierRow = {
  supplierAccountId: string;
  supplierName: string;
  sfType: string | null;
  isBMRetailer: boolean;
  colorsInCatalog: number;
  isCustomized: boolean;
};

type FieldDef = {
  key: keyof Template;
  label: string;
  help: string;
  rows: number;
};

const FIELDS: FieldDef[] = [
  {
    key: "subject",
    label: "Email subject",
    help: "Variables: {{po_number}}, {{customer_name}}, {{wo_number}}, {{supplier_name}}.",
    rows: 1,
  },
  {
    key: "greeting",
    label: "Greeting",
    help: "First line. Variables: {{supplier_name}}.",
    rows: 1,
  },
  {
    key: "intro",
    label: "Intro / order header block",
    help: "Variables: {{ppp_account_number}}, {{po_number}}, {{required_by_date}}, {{fulfillment_block}}, {{customer_name}}, {{wo_number}}, {{ppp_brand}}. Use blank lines for paragraph breaks.",
    rows: 8,
  },
  {
    key: "outro",
    label: "Closing paragraph",
    help: "Comes after the COLORS / EXTRAS / INSTRUCTIONS blocks. Variables: {{ppp_brand}}.",
    rows: 4,
  },
  {
    key: "signoff",
    label: "Signoff",
    help: "Variables: {{ppp_brand}}. Use \\n for new lines.",
    rows: 2,
  },
];

export default function SupplierTemplatesEditor() {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [defaults, setDefaults] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [totalCandidates, setTotalCandidates] = useState<number>(0);
  const [activeCount, setActiveCount] = useState<number>(0);
  const [showingFallback, setShowingFallback] = useState<boolean>(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch(`/api/admin/supplier-templates?filter=${filter}`);
      // Defensive: a Next 500 returns HTML, which res.json() throws on. Capture
      // the raw text so the error surface is informative instead of "Load failed".
      let data: {
        ok?: boolean;
        suppliers?: SupplierRow[];
        defaults?: Template;
        warning?: string;
        error?: string;
        message?: string;
        totalCandidates?: number;
        activeCount?: number;
        showingFallback?: boolean;
      };
      try {
        data = await res.json();
      } catch {
        setError(`Server returned non-JSON (HTTP ${res.status}). Try again or check the server logs.`);
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSuppliers(data.suppliers ?? []);
      setDefaults(data.defaults ?? null);
      setTotalCandidates(data.totalCandidates ?? 0);
      setActiveCount(data.activeCount ?? 0);
      setShowingFallback(data.showingFallback ?? false);
      if (data.warning) setWarning(data.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void loadList(); }, [loadList]);

  if (loading && suppliers.length === 0) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
        Loading suppliers from the snapshot…
      </div>
    );
  }
  if (error && suppliers.length === 0) {
    return (
      <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl p-4 text-sm text-ppp-orange-700 flex items-start justify-between gap-3 flex-wrap">
        <span>Couldn&apos;t load suppliers: {error}</span>
        <button
          type="button"
          onClick={() => void loadList()}
          className="shrink-0 px-3 py-1 rounded-lg border border-ppp-orange-100 bg-white text-xs font-semibold text-ppp-orange-700 hover:bg-ppp-orange-50 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-ppp-blue-50/40 border border-ppp-blue-100 rounded-xl px-5 py-4">
        <div className="font-condensed text-[11px] uppercase tracking-wider font-bold text-ppp-blue-700 mb-2">
          How per-supplier templates work
        </div>
        <p className="text-[11px] text-ppp-charcoal-500 leading-relaxed">
          Each supplier can override any field of the order email template (subject, greeting, intro,
          outro, signoff). Empty fields fall back to the shared code default — so you only need to
          customize the parts that should differ for that supplier. Edits take effect immediately on
          the next supplier-order send.
        </p>
      </div>

      {warning && (
        <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl px-4 py-3 text-xs text-ppp-orange-700 flex items-start justify-between gap-3 flex-wrap">
          <span>{warning}</span>
          <button
            type="button"
            onClick={() => void loadList()}
            className="shrink-0 px-2.5 py-0.5 rounded-lg border border-ppp-orange-100 bg-white text-[11px] font-semibold text-ppp-orange-700 hover:bg-ppp-orange-50 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Curated view toggle. Default shows only the 4-5 active suppliers PPP
          actually uses; "Show all" exposes every Vendor-typed SF Account for
          the rare case admin needs to enable a new one. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11px] text-ppp-charcoal-500">
          {filter === "active" ? (
            showingFallback ? (
              <>
                Showing top {suppliers.length} suppliers by paint catalog size. No active list curated yet —
                set <Link href="/dashboard/settings/suppliers">Active</Link> on the suppliers you actually use.
              </>
            ) : (
              <>Showing <span className="font-bold text-ppp-charcoal">{suppliers.length}</span> active suppliers · {totalCandidates} total in Salesforce</>
            )
          ) : (
            <>Showing all <span className="font-bold text-ppp-charcoal">{suppliers.length}</span> Vendor-typed accounts from Salesforce</>
          )}
        </div>
        <div className="inline-flex bg-ppp-charcoal-50 rounded-lg p-0.5 text-[11px] font-semibold">
          <button
            type="button"
            onClick={() => setFilter("active")}
            className={[
              "px-2.5 py-1 rounded-md transition-colors",
              filter === "active" ? "bg-white text-ppp-charcoal shadow-sm" : "text-ppp-charcoal-500 hover:text-ppp-charcoal",
            ].join(" ")}
          >
            Active ({activeCount || (showingFallback ? `top ${suppliers.length}` : "0")})
          </button>
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={[
              "px-2.5 py-1 rounded-md transition-colors",
              filter === "all" ? "bg-white text-ppp-charcoal shadow-sm" : "text-ppp-charcoal-500 hover:text-ppp-charcoal",
            ].join(" ")}
          >
            All ({totalCandidates})
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {suppliers.map((s) => (
          <SupplierTemplateRow
            key={s.supplierAccountId}
            supplier={s}
            defaults={defaults}
            expanded={expandedId === s.supplierAccountId}
            onToggle={() =>
              setExpandedId((prev) => (prev === s.supplierAccountId ? null : s.supplierAccountId))
            }
            onSaved={loadList}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── Per-supplier row ─── */

function SupplierTemplateRow({
  supplier,
  defaults,
  expanded,
  onToggle,
  onSaved,
}: {
  supplier: SupplierRow;
  defaults: Template | null;
  expanded: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const [currentTemplate, setCurrentTemplate] = useState<Template | null>(null);
  const [draft, setDraft] = useState<Template | null>(null);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Lazy-load the template when admin expands the row — saves a bunch of
  // queries on first paint of the list page (don't pre-fetch every supplier
  // when admin will only edit a few).
  useEffect(() => {
    if (!expanded || currentTemplate) return;
    let cancelled = false;
    (async () => {
      setFetching(true);
      try {
        const res = await fetch(
          `/api/admin/supplier-templates?supplierAccountId=${encodeURIComponent(supplier.supplierAccountId)}`
        );
        const data = await res.json();
        if (!cancelled && res.ok && data.ok) {
          setCurrentTemplate(data.template);
          setDraft(data.template);
        }
      } catch (err) {
        console.warn("[supplier-template-row] load failed:", err);
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, supplier.supplierAccountId, currentTemplate]);

  const dirtyKeys = useMemo(() => {
    if (!draft || !currentTemplate) return new Set<keyof Template>();
    const keys = new Set<keyof Template>();
    for (const k of Object.keys(currentTemplate) as Array<keyof Template>) {
      if (draft[k] !== currentTemplate[k]) keys.add(k);
    }
    return keys;
  }, [draft, currentTemplate]);
  const isDirty = dirtyKeys.size > 0;

  const handleSave = async () => {
    if (!draft || !isDirty || saving) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const patch: Partial<Template> = {};
      for (const k of dirtyKeys) patch[k] = draft[k];
      const res = await fetch("/api/admin/supplier-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierAccountId: supplier.supplierAccountId,
          supplierName: supplier.supplierName,
          patch,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setSaveResult({
          ok: false,
          message: data.message ?? data.error ?? `HTTP ${res.status}`,
        });
      } else {
        setCurrentTemplate(data.template);
        setDraft(data.template);
        setSaveResult({ ok: true, message: "Saved." });
        setTimeout(() => { setSaveResult(null); onSaved(); }, 1200);
      }
    } catch (err) {
      setSaveResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const resetField = (k: keyof Template) => {
    if (!defaults || !draft) return;
    setDraft({ ...draft, [k]: defaults[k] });
  };

  return (
    <div className={[
      "bg-white border rounded-xl overflow-hidden",
      supplier.isCustomized ? "border-ppp-blue-100" : "border-ppp-charcoal-100",
    ].join(" ")}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-3 px-5 py-4 hover:bg-ppp-charcoal-50/50 transition-colors text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-ppp-charcoal truncate">{supplier.supplierName}</h3>
            {supplier.isBMRetailer && (
              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-ppp-orange-50 text-ppp-orange-700 border border-ppp-orange-100">
                BM Retailer
              </span>
            )}
            {supplier.isCustomized ? (
              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-ppp-blue-50 text-ppp-blue-700 border border-ppp-blue-100">
                Custom
              </span>
            ) : (
              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-ppp-charcoal-50 text-ppp-charcoal-500 border border-ppp-charcoal-100">
                Using defaults
              </span>
            )}
          </div>
          <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
            {supplier.colorsInCatalog.toLocaleString()} color{supplier.colorsInCatalog === 1 ? "" : "s"} in PPP&apos;s catalog
          </div>
        </div>
        <span className="text-ppp-charcoal-500 shrink-0 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-ppp-charcoal-100 px-5 py-4 space-y-4">
          {fetching && !currentTemplate && (
            <div className="text-xs text-ppp-charcoal-500 italic">Loading template…</div>
          )}
          {draft && defaults && FIELDS.map((f) => {
            const isAtDefault = draft[f.key] === defaults[f.key];
            const isDirty = dirtyKeys.has(f.key);
            return (
              <div key={f.key}>
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <label className="block text-sm font-semibold text-ppp-charcoal">
                    {f.label}
                    {isDirty && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide font-bold text-ppp-orange-700">
                        Unsaved
                      </span>
                    )}
                  </label>
                  {!isAtDefault && (
                    <button
                      type="button"
                      onClick={() => resetField(f.key)}
                      className="text-[11px] text-ppp-blue hover:text-ppp-blue-700 font-medium"
                    >
                      Reset to default
                    </button>
                  )}
                </div>
                {f.rows > 1 ? (
                  <textarea
                    value={draft[f.key]}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    rows={f.rows}
                    className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue font-mono leading-relaxed"
                  />
                ) : (
                  <input
                    type="text"
                    value={draft[f.key]}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue font-mono"
                  />
                )}
                <p className="text-[11px] text-ppp-charcoal-500 mt-1">{f.help}</p>
              </div>
            );
          })}

          {draft && (
            <div className="flex items-center justify-between gap-3 pt-3 border-t border-ppp-charcoal-100">
              <div className="text-xs">
                {saveResult && (
                  <span className={saveResult.ok ? "text-ppp-green-700 font-semibold" : "text-ppp-orange-700 font-semibold"}>
                    {saveResult.ok ? "✓" : "⚠"} {saveResult.message}
                  </span>
                )}
                {!saveResult && (
                  <span className="text-ppp-charcoal-500 italic">
                    {isDirty ? `${dirtyKeys.size} unsaved change${dirtyKeys.size === 1 ? "" : "s"}` : "No changes"}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={!isDirty || saving}
                className="px-4 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
