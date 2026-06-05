"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Admin editor for the paint gallons calculator constants. Loads the effective
 * config (defaults + saved overrides), lets admin tune any value, and saves the
 * full set back. bufferPct is shown/edited as a percent (10) but stored as a
 * fraction (0.10).
 */

type ConfigMap = Record<string, number>;

type FieldDef = { key: string; label: string; suffix?: string; percent?: boolean; help?: string };
type Group = { title: string; note?: string; icon: React.ReactNode; fields: FieldDef[] };

/** Tiny stroke icons (inline SVG matches existing convention; no new dep). */
const ICON_SIZE = 16;
const baseIconProps = { width: ICON_SIZE, height: ICON_SIZE, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const IconDroplet = () => <svg {...baseIconProps}><path d="M12 2.5s6.5 7.2 6.5 11.5a6.5 6.5 0 1 1-13 0C5.5 9.7 12 2.5 12 2.5Z" /></svg>;
const IconRuler = () => <svg {...baseIconProps}><path d="M21.3 8.7 8.7 21.3a2.4 2.4 0 0 1-3.4 0L2.7 18.7a2.4 2.4 0 0 1 0-3.4L15.3 2.7a2.4 2.4 0 0 1 3.4 0l2.6 2.6a2.4 2.4 0 0 1 0 3.4Z" /><path d="m8 11 2 2M11 8l2 2M14 5l2 2M5 14l2 2M11 17l2 2" /></svg>;
const IconDoor = () => <svg {...baseIconProps}><path d="M6 2h12v20H6z" /><path d="M14 12h.5" /></svg>;
const IconFrame = () => <svg {...baseIconProps}><rect x="3" y="3" width="18" height="18" rx="1.5" /><path d="M7 7h10v10H7z" /></svg>;
const IconBucket = () => <svg {...baseIconProps}><path d="M5 8h14l-1.5 12.5a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 8Z" /><path d="M4 8c0-2.2 3.6-4 8-4s8 1.8 8 4" /></svg>;

const GROUPS: Group[] = [
  {
    title: "How far paint goes & how many coats",
    icon: <IconDroplet />,
    fields: [
      { key: "coverageSqftPerGallon", label: "Paint coverage", suffix: "sq ft / gal", help: "How many square feet one gallon covers. Most paint does 350–400; we use 375 to stay safe and never run short." },
      { key: "defaultCoats", label: "Coats of paint", help: "How many coats we assume when the job doesn't say. Standard is 2." },
      { key: "bufferPct", label: "Extra cushion", suffix: "%", percent: true, help: "A little extra added to every color so a crew never runs out mid-job. 10% means order 10% more." },
    ],
  },
  {
    title: "If a room's size isn't filled in, assume this",
    icon: <IconRuler />,
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
    icon: <IconDoor />,
    note: "Doors, windows, and closet openings aren't wall — we subtract their size from the wall area so you don't over-order.",
    fields: [
      { key: "deductDoorSqft", label: "A door covers", suffix: "sq ft", help: "Wall space one door takes up. About 20 sq ft." },
      { key: "deductWindowSqft", label: "A window covers", suffix: "sq ft", help: "Wall space one window takes up. About 15 sq ft." },
      { key: "deductClosetSqft", label: "A closet covers", suffix: "sq ft", help: "Wall space one closet opening takes up. About 30 sq ft." },
    ],
  },
  {
    title: "Trim & casings",
    icon: <IconFrame />,
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
    icon: <IconBucket />,
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
  /** Display-form values of the LAST SAVED state — used to compute the dirty
   *  set (which fields the user has edited but not yet saved). Reset on every
   *  successful save so "Discard" snaps back to what's actually persisted. */
  const [baseline, setBaseline] = useState<ConfigMap>({});
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
      const eff: ConfigMap = {};
      for (const k of Object.keys(data.defaults)) eff[k] = toDisplay(k, data.effective[k]);
      setValues(eff);
      setBaseline(eff);
      setStatus("ready");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Auto-dismiss the "Saved" confirmation so it doesn't linger after the user
  // moves on — but only when nothing's pending (don't hide it mid-save).
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  const setField = (key: string, raw: string) => {
    setSaved(false);
    const n = raw === "" ? NaN : Number(raw);
    setValues((prev) => ({ ...prev, [key]: n }));
  };

  /** Per-field reset → snap to the code default (the standard PPP value). */
  const resetField = (key: string) => {
    if (!defaults) return;
    setSaved(false);
    setValues((prev) => ({ ...prev, [key]: toDisplay(key, defaults[key]) }));
  };

  /** Discard unsaved edits → snap every field back to the last-saved values. */
  const discardChanges = () => {
    setSaved(false);
    setErrorMsg(null);
    setValues({ ...baseline });
  };

  /** Wipe every override → snap every field to the code defaults. (Doesn't
   *  save automatically; user still hits Save to commit.) */
  const resetToDefaults = () => {
    if (!defaults) return;
    setSaved(false);
    const eff: ConfigMap = {};
    for (const k of Object.keys(defaults)) eff[k] = toDisplay(k, defaults[k]);
    setValues(eff);
  };

  const { dirtyCount, dirtyKeys } = useMemo(() => {
    const keys = new Set<string>();
    for (const k of Object.keys(values)) {
      if (!Number.isFinite(values[k]) && !Number.isFinite(baseline[k])) continue;
      if (values[k] !== baseline[k]) keys.add(k);
    }
    return { dirtyCount: keys.size, dirtyKeys: keys };
  }, [values, baseline]);
  const isDirty = dirtyCount > 0;

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
        // Re-baseline from the server's echoed-back effective config, so any
        // server-side coercion (rounding, clamping) is reflected in the dirty
        // computation immediately — no "saved but still shows unsaved" jank.
        const eff: ConfigMap = {};
        for (const k of Object.keys(data.effective ?? {})) eff[k] = toDisplay(k, data.effective[k]);
        if (Object.keys(eff).length > 0) {
          setBaseline(eff);
          setValues(eff);
        } else {
          setBaseline({ ...values });
        }
        setSaved(true);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="space-y-5">
        {/* Skeleton mirroring the real layout so the page doesn't visually jump on load. */}
        <div className="h-12 rounded-lg bg-ppp-blue-50/60 animate-pulse" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
              <div className="h-4 w-56 rounded bg-ppp-charcoal-100 animate-pulse" />
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[1, 2, 3].map((j) => (
                <div key={j} className="space-y-2">
                  <div className="h-3 w-24 rounded bg-ppp-charcoal-100 animate-pulse" />
                  <div className="h-9 rounded-lg bg-ppp-charcoal-100/70 animate-pulse" />
                  <div className="h-3 w-32 rounded bg-ppp-charcoal-50 animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl p-4 text-sm text-ppp-orange-700 flex items-center justify-between gap-3">
        <span>Couldn&apos;t load settings: {errorMsg}</span>
        <button type="button" onClick={load} className="px-3 py-1.5 rounded-md border border-ppp-orange-200 bg-white text-xs font-medium text-ppp-orange-700 hover:bg-ppp-orange-100 transition-colors">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-up pb-24">
      <div className="rounded-lg border border-ppp-blue-100 bg-ppp-blue-50 px-4 py-3 text-xs text-ppp-blue-700">
        The system uses these numbers to estimate how much paint to order. They feed both the work-order screen and the order emails sent to suppliers. Change a number, hit Save, and it applies to the next order you build. Not sure about one? Leave it alone, or use &ldquo;Reset to standard&rdquo; to put it back.
      </div>

      {GROUPS.map((g) => (
        <div key={g.title} className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
            <div className="flex items-center gap-2 text-ppp-charcoal">
              <span className="text-ppp-blue-600">{g.icon}</span>
              <h3 className="text-sm font-semibold">{g.title}</h3>
            </div>
            {g.note && <p className="text-[11px] text-ppp-charcoal-500 mt-1 ml-6">{g.note}</p>}
          </div>
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-5">
            {g.fields.map((f) => {
              const def = defaults ? toDisplay(f.key, defaults[f.key]) : undefined;
              const changedFromDefault = def !== undefined && Number.isFinite(values[f.key]) && values[f.key] !== def;
              const isUnsaved = dirtyKeys.has(f.key);
              return (
                <div key={f.key}>
                  <div className="flex items-baseline justify-between mb-1 gap-2">
                    <label htmlFor={`cov-${f.key}`} className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500">
                      {f.label} {f.suffix && <span className="lowercase tracking-normal text-ppp-charcoal-400">({f.suffix})</span>}
                    </label>
                    {changedFromDefault && (
                      <button
                        type="button"
                        onClick={() => resetField(f.key)}
                        className="text-[11px] font-medium text-ppp-blue-600 hover:text-ppp-blue-700 active:text-ppp-blue-800 transition-colors px-2 py-1 -mx-2 -my-1 touch-manipulation"
                        title={`Reset to standard (${def}${f.suffix ? " " + f.suffix : ""})`}
                      >
                        ↺ standard
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      id={`cov-${f.key}`}
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min={0}
                      value={Number.isFinite(values[f.key]) ? values[f.key] : ""}
                      onChange={(e) => setField(f.key, e.target.value)}
                      className={`w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue transition-colors ${
                        isUnsaved
                          ? "border-ppp-blue-300 bg-ppp-blue-50/50 ring-1 ring-ppp-blue/10"
                          : changedFromDefault
                          ? "border-ppp-blue-100 bg-ppp-blue-50/30"
                          : "border-ppp-charcoal-100"
                      }`}
                      aria-describedby={`cov-${f.key}-help`}
                    />
                    {isUnsaved && (
                      <span
                        className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-ppp-blue-500"
                        aria-label="Unsaved change"
                        title="Unsaved change"
                      />
                    )}
                  </div>
                  <div id={`cov-${f.key}-help`} className="text-[10px] text-ppp-charcoal-400 mt-1 leading-snug">
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

      {/* Action bar — sticky-ish at the bottom of the page so the user doesn't
          have to scroll back up after changing a value. The pb-24 on the
          container above leaves room beneath the last group for this bar. */}
      <div
        className={`sticky bottom-3 z-10 flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl border shadow-sm transition-all ${
          isDirty
            ? "bg-white border-ppp-blue-200 shadow-ppp-blue-100/40"
            : "bg-white/80 backdrop-blur-sm border-ppp-charcoal-100"
        }`}
      >
        <button
          type="button"
          onClick={save}
          disabled={saving || !isDirty}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? (
            <>
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                <path d="M21 12a9 9 0 1 1-6.2-8.55" />
              </svg>
              Saving…
            </>
          ) : (
            "Save changes"
          )}
        </button>

        {isDirty ? (
          <button
            type="button"
            onClick={discardChanges}
            disabled={saving}
            className="px-3 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 transition-colors disabled:opacity-50"
          >
            Discard changes
          </button>
        ) : (
          <button
            type="button"
            onClick={resetToDefaults}
            className="px-3 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 transition-colors"
            title="Snap every field back to the standard PPP values (still need to Save)"
          >
            Reset all to standards
          </button>
        )}

        {isDirty && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ppp-blue-50 text-ppp-blue-700 text-[11px] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-ppp-blue-500" aria-hidden />
            {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
          </span>
        )}

        {saved && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-ppp-green-700 animate-fade-up">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m5 12 4 4 10-10" />
            </svg>
            Saved
          </span>
        )}

        {errorMsg && (
          <span className="text-xs text-ppp-orange-700">{errorMsg}</span>
        )}
      </div>
    </div>
  );
}
