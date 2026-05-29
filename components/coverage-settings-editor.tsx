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
    title: "How far paint goes & how many coats",
    fields: [
      { key: "coverageSqftPerGallon", label: "Paint coverage", suffix: "sq ft / gal", help: "How many square feet one gallon covers. Most paint does 350–400; we use 375 to stay safe and never run short." },
      { key: "defaultCoats", label: "Coats of paint", help: "How many coats we assume when the job doesn't say. Standard is 2." },
      { key: "bufferPct", label: "Extra cushion", suffix: "%", percent: true, help: "A little extra added to every color so a crew never runs out mid-job. 10% means order 10% more." },
    ],
  },
  {
    title: "If a room's size isn't filled in, assume this",
    note: "Salesforce often doesn't have a room's exact height or door/window counts. These are the fallback guesses used when it's blank.",
    fields: [
      { key: "defaultHeightFt", label: "Ceiling height", suffix: "ft", help: "Assumed room height when it isn't recorded. Most homes are 8 ft." },
      { key: "defaultDoorsPerRoom", label: "Doors per room", help: "Assumed number of doors when not recorded." },
      { key: "defaultWindowsPerRoom", label: "Windows per room", help: "Assumed number of windows when not recorded." },
      { key: "defaultClosetsPerRoom", label: "Closets per room", help: "Assumed number of closets when not recorded." },
    ],
  },
  {
    title: "Wall space that doesn't get painted",
    note: "Doors, windows, and closet openings aren't wall — we subtract their size from the wall area so you don't over-order.",
    fields: [
      { key: "deductDoorSqft", label: "A door covers", suffix: "sq ft", help: "Wall space one door takes up. About 20 sq ft." },
      { key: "deductWindowSqft", label: "A window covers", suffix: "sq ft", help: "Wall space one window takes up. About 15 sq ft." },
      { key: "deductClosetSqft", label: "A closet covers", suffix: "sq ft", help: "Wall space one closet opening takes up. About 30 sq ft." },
    ],
  },
  {
    title: "Trim & casings",
    note: "Trim paint is figured from the trim around the room plus the casing around each door, window, and closet.",
    fields: [
      { key: "casingDoorLf", label: "Trim around a door", suffix: "linear ft", help: "Feet of casing around one door. About 17 ft." },
      { key: "casingWindowLf", label: "Trim around a window", suffix: "linear ft", help: "Feet of casing around one window. About 15 ft." },
      { key: "casingClosetLf", label: "Trim around a closet", suffix: "linear ft", help: "Feet of casing around one closet. About 18 ft." },
      { key: "trimWidthFt", label: "Trim width", suffix: "ft", help: "How wide the trim is, to turn length into paintable area. 3 inches = 0.25 ft." },
      { key: "doorFaceSqft", label: "Door face", suffix: "sq ft", help: "Paint for the room-facing side of a door. Added automatically whenever a work order lists a door count for the room. About 20 sq ft." },
    ],
  },
  {
    title: "Single gallons vs. buckets",
    note: "Small amounts are ordered as single gallons; bigger amounts switch to 5-gallon buckets (cheaper per gallon).",
    fields: [
      { key: "bucketThresholdGallons", label: "Switch to buckets above", suffix: "gal", help: "Order single gallons up to this amount; more than this, order a bucket instead. Standard is 4." },
      { key: "bucketSizeGallons", label: "Bucket size", suffix: "gal", help: "How many gallons are in one bucket. Standard is 5." },
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
        The system uses these numbers to estimate how much paint to order. They feed both the work-order screen and the order emails sent to suppliers. Change a number, hit Save, and it applies to the next order you build. Not sure about one? Leave it alone, or use &ldquo;Reset to defaults&rdquo; to put everything back.
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
                  <div className="text-[10px] text-ppp-charcoal-400 mt-1 leading-snug">
                    {f.help && <span className="block">{f.help}</span>}
                    {def !== undefined && (
                      <span className="block text-ppp-charcoal-400">
                        Standard: {def}{f.suffix ? ` ${f.suffix}` : ""}
                      </span>
                    )}
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
