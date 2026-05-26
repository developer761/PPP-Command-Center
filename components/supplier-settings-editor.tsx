"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Supplier Settings editor. Lists every supplier the snapshot knows about
 * (vendor-typed Accounts + any color manufacturer referenced by PaintColor),
 * shows which are configured vs missing data, and lets admin edit each one
 * inline.
 *
 * Sort order: most-used supplier first (by color count in PPP's catalog) so
 * BM + SW float to the top.
 *
 * Edits are saved one supplier at a time via PUT /api/admin/supplier-settings.
 * Each row tracks its own "saving" + "savedAt" state so admin can edit
 * multiple suppliers without batching.
 */

type CandidateRow = {
  supplierAccountId: string;
  supplierName: string;
  sfType: string | null;
  isBMRetailer: boolean;
  settings: {
    supplier_account_id: string;
    supplier_name: string;
    order_email: string | null;
    ppp_account_number: string | null;
    pickup_locations: Array<{ name: string; address: string }>;
    preferred_template_key: string | null;
    is_active: boolean;
    updated_at: string;
  } | null;
  colorsInCatalog: number;
  gaps: string[];
};

type Summary = {
  totalCandidates: number;
  withSettings: number;
  readyToSend: number;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; candidates: CandidateRow[]; summary: Summary }
  | { status: "error"; message: string };

export default function SupplierSettingsEditor() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/admin/supplier-settings");
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setState({ status: "error", message: data.message ?? data.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({
        status: "ready",
        candidates: data.candidates ?? [],
        summary: data.summary,
      });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state.status === "loading") {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
        Loading suppliers from the Salesforce snapshot…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl p-4 text-sm text-ppp-orange-700">
        Couldn&apos;t load suppliers: {state.message}
        <button
          type="button"
          onClick={load}
          className="ml-3 underline text-ppp-orange-700 hover:text-ppp-orange-900"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary chips */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <SummaryChip label="Suppliers" value={state.summary.totalCandidates} accent="navy" />
          <SummaryChip label="Configured" value={state.summary.withSettings} accent="blue" />
          <SummaryChip
            label="Ready to send"
            value={state.summary.readyToSend}
            accent={state.summary.readyToSend > 0 ? "green" : "muted"}
            sub={state.summary.readyToSend === 0 ? "no suppliers have order email set yet" : `of ${state.summary.totalCandidates}`}
          />
        </div>
        <p className="text-[11px] text-ppp-charcoal-500 mt-2.5 leading-relaxed">
          Each supplier needs an <strong>order email</strong> set before the Supplier Order Modal can send orders to them.
          PPP&apos;s account number is recommended (gets substituted into the email body) but not strictly required.
          Sorted by color count in PPP&apos;s catalog — top suppliers first.
        </p>
      </div>

      {/* Supplier list */}
      <div className="space-y-3">
        {state.candidates.map((c) => (
          <SupplierRow key={c.supplierAccountId} candidate={c} onSaved={load} />
        ))}
      </div>
    </div>
  );
}

/* ─── Per-supplier editable row ─── */

function SupplierRow({ candidate, onSaved }: { candidate: CandidateRow; onSaved: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [orderEmail, setOrderEmail] = useState(candidate.settings?.order_email ?? "");
  const [accountNumber, setAccountNumber] = useState(candidate.settings?.ppp_account_number ?? "");
  const [pickupLocations, setPickupLocations] = useState<Array<{ name: string; address: string }>>(
    candidate.settings?.pickup_locations ?? []
  );
  const [isActive, setIsActive] = useState(candidate.settings?.is_active ?? true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);

  const isDirty = useMemo(() => {
    return (
      orderEmail !== (candidate.settings?.order_email ?? "") ||
      accountNumber !== (candidate.settings?.ppp_account_number ?? "") ||
      JSON.stringify(pickupLocations) !== JSON.stringify(candidate.settings?.pickup_locations ?? []) ||
      isActive !== (candidate.settings?.is_active ?? true)
    );
  }, [orderEmail, accountNumber, pickupLocations, isActive, candidate.settings]);

  const handleSave = async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/admin/supplier-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplier_account_id: candidate.supplierAccountId,
          supplier_name: candidate.supplierName,
          order_email: orderEmail.trim() || null,
          ppp_account_number: accountNumber.trim() || null,
          pickup_locations: pickupLocations.filter((p) => p.name.trim()),
          is_active: isActive,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveResult({ ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` });
      } else {
        setSaveResult({ ok: true, message: "Saved" });
        // Refresh the parent list so summary chips + gap pills update
        setTimeout(() => { onSaved(); setSaveResult(null); }, 800);
      }
    } catch (err) {
      setSaveResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const addPickupLocation = () => {
    setPickupLocations((prev) => [...prev, { name: "", address: "" }]);
  };
  const removePickupLocation = (idx: number) => {
    setPickupLocations((prev) => prev.filter((_, i) => i !== idx));
  };
  const updatePickupLocation = (idx: number, patch: Partial<{ name: string; address: string }>) => {
    setPickupLocations((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const ready = !!candidate.settings?.order_email;

  return (
    <div className={[
      "bg-white border rounded-xl overflow-hidden",
      ready ? "border-ppp-green-100" : candidate.gaps.length > 0 ? "border-ppp-orange-100" : "border-ppp-charcoal-100",
    ].join(" ")}>
      {/* Header — clickable to expand */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start justify-between gap-3 px-5 py-4 hover:bg-ppp-charcoal-50/50 transition-colors text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-ppp-charcoal truncate">{candidate.supplierName}</h3>
            {candidate.isBMRetailer && (
              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-ppp-orange-50 text-ppp-orange-700 border border-ppp-orange-100">
                BM Retailer
              </span>
            )}
            {ready ? (
              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-ppp-green-50 text-ppp-green-700 border border-ppp-green-100">
                ✓ Ready
              </span>
            ) : (
              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-ppp-orange-50 text-ppp-orange-700 border border-ppp-orange-100">
                Needs email
              </span>
            )}
          </div>
          <div className="text-[11px] text-ppp-charcoal-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>{candidate.colorsInCatalog.toLocaleString()} color{candidate.colorsInCatalog === 1 ? "" : "s"} in catalog</span>
            {candidate.settings?.order_email && (
              <span>· Email: <span className="font-mono text-ppp-charcoal">{candidate.settings.order_email}</span></span>
            )}
            {candidate.settings?.ppp_account_number && (
              <span>· Acct: <span className="font-mono text-ppp-charcoal">{candidate.settings.ppp_account_number}</span></span>
            )}
          </div>
        </div>
        <span className="text-ppp-charcoal-500 shrink-0 text-xs">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {/* Expanded editor */}
      {expanded && (
        <div className="border-t border-ppp-charcoal-100 px-5 py-4 space-y-4">
          <Field
            label="Order email"
            help="Where outbound orders to this supplier will be sent. Required for the Send button on the Supplier Order Modal."
            isRequired={!ready}
          >
            <input
              type="email"
              value={orderEmail}
              onChange={(e) => setOrderEmail(e.target.value)}
              placeholder={`orders@${candidate.supplierName.toLowerCase().replace(/[^a-z]/g, "")}.com`}
              className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue font-mono"
            />
          </Field>

          <Field
            label="PPP account number with this supplier"
            help="Contractor/pro account #. Substituted into the email body so the supplier knows it's a PPP order."
          >
            <input
              type="text"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder="e.g. 12345678 (PPP's contractor number)"
              className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue font-mono"
            />
          </Field>

          <Field
            label={`Pickup locations (${pickupLocations.length})`}
            help="Supplier branches PPP can pick up at. Shows as a dropdown when the worker selects 'Pickup' on the Supplier Order Modal."
          >
            <div className="space-y-2">
              {pickupLocations.map((loc, idx) => (
                <div key={idx} className="grid grid-cols-1 sm:grid-cols-[160px_1fr_auto] gap-2 items-start">
                  <input
                    type="text"
                    value={loc.name}
                    onChange={(e) => updatePickupLocation(idx, { name: e.target.value })}
                    placeholder="Branch name (e.g. Smithtown)"
                    className="px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                  />
                  <input
                    type="text"
                    value={loc.address}
                    onChange={(e) => updatePickupLocation(idx, { address: e.target.value })}
                    placeholder="123 Main St, Smithtown NY 11787"
                    className="px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                  />
                  <button
                    type="button"
                    onClick={() => removePickupLocation(idx)}
                    className="px-2 py-2 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal-500 hover:bg-ppp-orange-50 hover:text-ppp-orange-700 hover:border-ppp-orange-100 transition-colors text-xs"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addPickupLocation}
                className="text-xs text-ppp-blue hover:text-ppp-blue-700 font-medium"
              >
                + Add pickup location
              </button>
            </div>
          </Field>

          <Field label="Active">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              <span className="text-sm text-ppp-charcoal">
                {isActive ? "Active — appears in Supplier Order Modal" : "Inactive — hidden from order workflow"}
              </span>
            </label>
          </Field>

          {/* Save action */}
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-ppp-charcoal-100">
            <div className="text-xs">
              {saveResult && (
                <span className={saveResult.ok ? "text-ppp-green-700 font-semibold" : "text-ppp-orange-700 font-semibold"}>
                  {saveResult.ok ? "✓" : "⚠"} {saveResult.message}
                </span>
              )}
              {!saveResult && candidate.settings?.updated_at && (
                <span className="text-ppp-charcoal-500 italic">
                  Last saved {new Date(candidate.settings.updated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
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
        </div>
      )}
    </div>
  );
}

/* ─── Helpers ─── */

function Field({
  label,
  help,
  isRequired,
  children,
}: {
  label: string;
  help?: string;
  isRequired?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1.5">
        {label}
        {isRequired && <span className="ml-1 text-ppp-orange-700 font-bold">*</span>}
      </label>
      {children}
      {help && <p className="text-[10px] text-ppp-charcoal-500 mt-1 leading-relaxed">{help}</p>}
    </div>
  );
}

function SummaryChip({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: number;
  accent: "navy" | "blue" | "green" | "muted";
  sub?: string;
}) {
  const cls =
    accent === "green" ? "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100"
    : accent === "blue" ? "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100"
    : accent === "muted" ? "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100"
    : "bg-white text-ppp-navy border-ppp-charcoal-100";
  return (
    <div className={`inline-flex items-baseline gap-1.5 px-3 py-1.5 rounded-lg border ${cls}`}>
      <span className="font-condensed text-lg font-bold">{value}</span>
      <span className="text-[11px] uppercase tracking-wide font-semibold">{label}</span>
      {sub && <span className="text-[10px] opacity-80 ml-1">· {sub}</span>}
    </div>
  );
}
