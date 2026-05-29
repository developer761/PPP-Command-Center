"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Admin editor for the paint gallons calculator constants. Loads the effective
 * config (defaults + saved overrides), lets admin tune any value, and saves the
 * full set back. bufferPct is shown/edited as a percent (10) but stored as a
 * fraction (0.10).
 */

type ConfigMap = Record<string, number>;

type FieldDef = { key: string; label: string; suffix?: string; percent?: boolean; help?: string };
type Group = { title: string; note?: string; fields: FieldDef[] };

const GROUPS: Group[] = [
  {
    title: "Coverage & coats",
    fields: [
      { key: "coverageSqftPerGallon", label: "Coverage rate", suffix: "sq ft / gal", help: "BM Regal ~400; 375 is conservative" },
      { key: "defaultCoats", label: "Default coats", help: "When the line item doesn't specify" },
      { key: "bufferPct", label: "Buffer", suffix: "%", percent: true, help: "Added to every color at the job level" },
    ],
  },
  {
    title: "Room defaults (used when a room's dimensions aren't entered)",
    fields: [
      { key: "defaultHeightFt", label: "Ceiling height", suffix: "ft" },
      { key: "defaultDoorsPerRoom", label: "Doors / room" },
      { key: "defaultWindowsPerRoom", label: "Windows / room" },
      { key: "defaultClosetsPerRoom", label: "Closets / room" },
    ],
  },
  {
    title: "Wall deductions (subtracted from wall area, per opening)",
    fields: [
      { key: "deductDoorSqft", label: "Door", suffix: "sq ft" },
      { key: "deductWindowSqft", label: "Window", suffix: "sq ft" },
      { key: "deductClosetSqft", label: "Closet", suffix: "sq ft" },
    ],
  },
  {
    title: "Trim (casings added per opening + width)",
    fields: [
      { key: "casingDoorLf", label: "Door casing", suffix: "lin ft" },
      { key: "casingWindowLf", label: "Window casing", suffix: "lin ft" },
      { key: "casingClosetLf", label: "Closet casing", suffix: "lin ft" },
      { key: "trimWidthFt", label: "Trim width", suffix: "ft", help: "Converts linear ft → sq ft (3\" = 0.25)" },
      { key: "doorFaceSqft", label: "Door face", suffix: "sq ft", help: "Single-sided, when door faces are in scope" },
    ],
  },
  {
    title: "Packaging",
    note: "Individual gallons up to the threshold; switch to buckets above it.",
    fields: [
      { key: "bucketThresholdGallons", label: "Bucket threshold", suffix: "gal" },
      { key: "bucketSizeGallons", label: "Bucket size", suffix: "gal" },
    ],
  },
];

const toDisplay = (key: string, v: number) => (key === "bufferPct" ? Math.round(v * 1000) / 10 : v);
const toStored = (key: string, v: number) => (key === "bufferPct" ? v / 100 : v);

export default function CoverageSettingsEditor() {
  const [defaults, setDefaults] = useState<ConfigMap | null>(null);
  const [values, setValues] = useState<ConfigMap>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch("/api/admin/coverage-config");
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMsg(data.message ?? data.error ?? `HTTP ${res.status}`);
        setStatus("error");
        return;
      }
      setDefaults(data.defaults);
      // Seed the form from the EFFECTIVE config (defaults + saved overrides).
      const eff: ConfigMap = {};
      for (const k of Object.keys(data.defaults)) eff[k] = toDisplay(k, data.effective[k]);
      setValues(eff);
      setStatus("ready");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setField = (key: string, raw: string) => {
    setSaved(false);
    const n = raw === "" ? NaN : Number(raw);
    setValues((prev) => ({ ...prev, [key]: n }));
  };

  const resetToDefaults = () => {
    if (!defaults) return;
    setSaved(false);
    const eff: ConfigMap = {};
    for (const k of Object.keys(defaults)) eff[k] = toDisplay(k, defaults[k]);
    setValues(eff);
  };

  const save = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      const config: ConfigMap = {};
      for (const k of Object.keys(values)) {
        if (Number.isFinite(values[k])) config[k] = toStored(k, values[k]);
      }
      const res = await fetch("/api/admin/coverage-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMsg(data.message ?? data.error ?? `HTTP ${res.status}`);
      } else {
        setSaved(true);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") {
    return <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">Loading coverage settings…</div>;
  }
  if (status === "error") {
    return (
      <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl p-4 text-sm text-ppp-orange-700">
        Couldn&apos;t load settings: {errorMsg}
        <button type="button" onClick={load} className="ml-3 underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-up">
      <div className="rounded-lg border border-ppp-blue-100 bg-ppp-blue-50 px-4 py-3 text-xs text-ppp-blue-700">
        These tune the gallon calculator everywhere — supplier orders + the work-order estimate. Changes take effect on the next order. Leave a value at its default to keep the standard.
      </div>

      {GROUPS.map((g) => (
        <div key={g.title} className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
            <h3 className="text-sm font-semibold text-ppp-charcoal">{g.title}</h3>
            {g.note && <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">{g.note}</p>}
          </div>
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {g.fields.map((f) => {
              const def = defaults ? toDisplay(f.key, defaults[f.key]) : undefined;
              const changed = def !== undefined && Number.isFinite(values[f.key]) && values[f.key] !== def;
              return (
                <div key={f.key}>
                  <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
                    {f.label} {f.suffix && <span className="lowercase tracking-normal">({f.suffix})</span>}
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min={0}
                    value={Number.isFinite(values[f.key]) ? values[f.key] : ""}
                    onChange={(e) => setField(f.key, e.target.value)}
                    className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue ${changed ? "border-ppp-blue-200 bg-ppp-blue-50/40" : "border-ppp-charcoal-100"}`}
                  />
                  <div className="text-[10px] text-ppp-charcoal-400 mt-1 min-h-[1.1em]">
                    {f.help ?? (def !== undefined ? `default ${def}${f.suffix ? ` ${f.suffix}` : ""}` : "")}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save coverage settings"}
        </button>
        <button
          type="button"
          onClick={resetToDefaults}
          className="px-4 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors"
        >
          Reset to defaults
        </button>
        {saved && <span className="text-xs font-medium text-ppp-green-700">Saved ✓</span>}
        {errorMsg && <span className="text-xs text-ppp-orange-700">{errorMsg}</span>}
      </div>
    </div>
  );
}
