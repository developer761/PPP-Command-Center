"use client";

import { useMemo, useRef, useState } from "react";
import { geometryFromDimensions, perimeterGainVsSquareGuess, distributeHouseSqft } from "@/lib/measure/geometry";
import { CONFIDENCE_LABEL, SOURCE_LABEL, type MeasureSuggestion, type MeasureConfidence } from "@/lib/measure/types";
import MeasurePhotoTool, { type PhotoMeasureResult } from "@/components/measure-photo-tool";
import MeasureFloorPlan from "@/components/measure-floor-plan";
import MeasureLiveCamera from "@/components/measure-live-camera";
import MeasureAR, { useArSupported } from "@/components/measure-ar";
import FeetInchesInput, { fromDecimalFeet, toDecimalFeet } from "@/components/feet-inches-input";

/**
 * Standalone sandbox for the room-measurement tool.
 *
 * Deliberately NOT connected to work orders or materials ordering yet. Nothing
 * here writes to `wo_li_sqft_overrides`, so no number produced while testing can
 * reach a supplier order. The point is to find out whether the four capture
 * methods are actually good enough BEFORE they can affect what PPP buys.
 *
 * Everything runs against the same libraries the connected version would use,
 * so whatever this proves out is what ships — no second implementation to drift.
 */

type Row = {
  id: string;
  label: string;
  lengthFt: string;
  widthFt: string;
  ceilingFt: string;
  /** What a capture method proposed for this room. */
  suggestion: MeasureSuggestion | null;
  busy: boolean;
  error: string | null;
  /** Set only in work-order mode — the line item this room saves to. */
  woliId?: string;
  saved?: boolean;
  /** Set when the room was WALKED. Carries the true area and perimeter, which
   *  length × width cannot express for an L-shaped or bumped-out room — so
   *  these override the derived values rather than being recomputed. */
  planAreaSqft?: number;
  planPerimeterLf?: number;
  planWallCount?: number;
};

type WorkOrderOption = {
  id: string; number: string; customer: string; rooms: number; unmeasured: number;
};

const CONF_TONE: Record<MeasureConfidence, string> = {
  high: "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100",
  medium: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100",
  low: "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100",
};

const STARTERS = ["Living Room", "Master Bedroom", "Kitchen", "Bathroom"];
let seq = 0;
const newRow = (label: string): Row => ({
  id: `r${++seq}`, label, lengthFt: "", widthFt: "", ceilingFt: "",
  suggestion: null, busy: false, error: null,
});

export default function MeasureSandbox() {
  const [rows, setRows] = useState<Row[]>(() => STARTERS.map(newRow));
  const [addr, setAddr] = useState({ street: "", city: "", state: "NY", postalCode: "" });
  // Work-order mode. Null = free-form sandbox, where nothing can be saved.
  const [wo, setWo] = useState<{ id: string; number: string | null; customer: string | null } | null>(null);
  const [woList, setWoList] = useState<WorkOrderOption[]>([]);
  const [woQuery, setWoQuery] = useState("");
  const [woBusy, setWoBusy] = useState(false);
  const [woOpen, setWoOpen] = useState(false);
  const [addrBusy, setAddrBusy] = useState(false);
  const [addrNote, setAddrNote] = useState<string | null>(null);

  const patch = (id: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const totals = useMemo(() => {
    let sqft = 0, wall = 0, measured = 0, assumedCeilings = 0;
    for (const r of rows) {
      const L = parseFloat(r.lengthFt) || 0, W = parseFloat(r.widthFt) || 0;
      if (r.planAreaSqft) {
        // Walked: real area AND real perimeter, so the wall figure uses the
        // room's actual shape rather than a rectangle standing in for it.
        const h = parseFloat(r.ceilingFt) || 8;
        if (!(parseFloat(r.ceilingFt) > 0)) assumedCeilings++;
        sqft += r.planAreaSqft;
        wall += Math.round((r.planPerimeterLf ?? 0) * h);
        measured++;
      } else if (L > 0 && W > 0) {
        const g = geometryFromDimensions({ lengthFt: L, widthFt: W, ceilingFt: parseFloat(r.ceilingFt) || 0 });
        if (g.ceilingAssumed) assumedCeilings++;
        sqft += g.floorAreaSqft; wall += g.paintableWallSqft; measured++;
      } else if (r.suggestion) {
        sqft += r.suggestion.sqft; measured++;
      }
    }
    return { sqft: Math.round(sqft), wall: Math.round(wall), measured, assumedCeilings };
  }, [rows]);

  async function searchWorkOrders(q: string) {
    setWoBusy(true);
    try {
      const res = await fetch("/api/admin/measure", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "workOrders", query: q }),
      });
      const data = await res.json();
      setWoList(data.workOrders ?? []);
    } catch { setWoList([]); }
    finally { setWoBusy(false); }
  }

  async function openWorkOrder(id: string) {
    setWoBusy(true);
    try {
      const res = await fetch("/api/admin/measure", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rooms", workOrderId: id }),
      });
      const data = await res.json();
      if (!data.ok) return;
      setWo(data.workOrder);
      setWoOpen(false);
      if (data.address) setAddr(data.address);
      setRows(
        (data.rooms as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.woliId),
          woliId: String(r.woliId),
          label: String(r.label),
          // Seed from whatever exists: a previous capture first, then whatever
          // Salesforce already had — so re-opening a job shows the work rather
          // than asking for it again.
          lengthFt: r.lengthFt != null ? String(r.lengthFt) : "",
          widthFt: r.widthFt != null ? String(r.widthFt) : "",
          ceilingFt: r.ceilingFt != null ? String(r.ceilingFt) : "",
          suggestion:
            !r.lengthFt && (r.savedSqft || r.sfSqft)
              ? {
                  source: (r.savedSource as never) ?? "manual",
                  confidence: "medium",
                  sqft: Number(r.savedSqft ?? r.sfSqft),
                  rationale: r.savedSqft ? "Already captured for this room." : "Already on the work order in Salesforce.",
                }
              : null,
          busy: false, error: null, saved: false,
        }))
      );
    } finally { setWoBusy(false); }
  }

  function leaveWorkOrder() {
    setWo(null);
    setRows(STARTERS.map(newRow));
    setAddr({ street: "", city: "", state: "NY", postalCode: "" });
  }

  async function lookupAddress() {
    setAddrBusy(true); setAddrNote(null);
    try {
      const res = await fetch("/api/admin/measure", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "address", address: addr, rooms: rows.map((r) => ({ id: r.id, label: r.label })) }),
      });
      const data = await res.json();
      if (!data.ok) { setAddrNote(data.message ?? "Couldn't look that up."); return; }
      setRows((rs) => rs.map((r) => (data.byRoom?.[r.id] ? { ...r, suggestion: data.byRoom[r.id] } : r)));
      setAddrNote(`Found ${Number(data.property?.buildingSqft ?? 0).toLocaleString()} sq ft on record — split across ${rows.length} rooms below.`);
    } catch { setAddrNote("Couldn't reach the lookup."); }
    finally { setAddrBusy(false); }
  }

  /** Only reachable in work-order mode — the sandbox has no woliId, so a
   *  free-form room can never write to a real job. */
  async function saveRoom(row: Row) {
    if (!row.woliId || !wo) return;
    const L = parseFloat(row.lengthFt) || 0, W = parseFloat(row.widthFt) || 0;
    // A walked plan wins: it knows the room's real shape, where length × width
    // can only ever describe a rectangle.
    const sqft = row.planAreaSqft
      ? row.planAreaSqft
      : L > 0 && W > 0
        ? geometryFromDimensions({ lengthFt: L, widthFt: W, ceilingFt: parseFloat(row.ceilingFt) || 0 }).floorAreaSqft
        : row.suggestion?.sqft ?? 0;
    if (!sqft) { patch(row.id, { error: "Measure it or pick a suggestion first." }); return; }
    patch(row.id, { busy: true, error: null });
    try {
      const res = await fetch("/api/admin/measure", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save", woliId: row.woliId, workOrderId: wo.id, roomLabel: row.label,
          sqft,
          // Send the walked perimeter explicitly. Without it the server would
          // derive 2(L+W) from the bounding box and throw away the one number
          // walking the room exists to produce.
          perimeterLf: row.planPerimeterLf ?? null,
          lengthFt: row.planAreaSqft ? null : L || null,
          widthFt: row.planAreaSqft ? null : W || null,
          ceilingFt: parseFloat(row.ceilingFt) || null,
          source: row.planAreaSqft || (L > 0 && W > 0) ? "dimensions" : row.suggestion?.source ?? "manual",
          confidence: row.planAreaSqft || (L > 0 && W > 0) ? "high" : row.suggestion?.confidence ?? "medium",
          suggestion: row.suggestion,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) patch(row.id, { error: data.message ?? "Couldn't save." });
      else patch(row.id, { saved: true });
    } catch { patch(row.id, { error: "Couldn't save — check your signal." }); }
    finally { patch(row.id, { busy: false }); }
  }

  async function onPhoto(row: Row, file: File) {
    patch(row.id, { busy: true, error: null });
    try {
      const img = await downscale(file, 1024);
      const res = await fetch("/api/admin/measure", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "photo", roomLabel: row.label, imageBase64: img.base64, mediaType: img.mediaType,
          knownHintFt: parseFloat(row.ceilingFt) || null,
          knownHintLabel: parseFloat(row.ceilingFt) ? "the ceiling height" : null,
        }),
      });
      const data = await res.json();
      if (!data.ok) patch(row.id, { error: data.message ?? "Couldn't read that photo." });
      else patch(row.id, { suggestion: data.suggestion as MeasureSuggestion });
    } catch { patch(row.id, { error: "Couldn't process that photo." }); }
    finally { patch(row.id, { busy: false }); }
  }

  return (
    <div className="space-y-5 pb-10">
      <div>
        <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-blue-700 font-bold">
          {wo ? "Work order" : "Sandbox"}
        </div>
        <h1 className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy mt-1">
          {wo ? `${wo.customer ?? "(unknown)"}` : "Room measurement"}
        </h1>
        <p className="text-xs text-ppp-charcoal-500 mt-1.5 leading-relaxed max-w-2xl">
          {wo
            ? `WO ${wo.number ?? ""} — measurements save straight onto these rooms, so the materials order can size the paint.`
            : "Try the four ways of getting square footage. Nothing here touches a real job until you pick a work order below."}
        </p>
      </div>

      {/* Pick a job, or stay in the sandbox. Kept at the top because which
          mode you're in changes whether anything can be saved. */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-4">
        {wo ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-ppp-charcoal-600">
              Working on <strong className="text-ppp-charcoal">WO {wo.number}</strong>
            </span>
            <button type="button" onClick={leaveWorkOrder}
              className="text-xs font-medium text-ppp-blue-700 hover:underline min-h-[44px] sm:min-h-0 px-1">
              Leave — back to the sandbox
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-ppp-charcoal">Measure a real work order</h2>
              <button
                type="button"
                onClick={() => { setWoOpen((o) => !o); if (!woOpen && woList.length === 0) void searchWorkOrders(""); }}
                className="text-xs font-medium text-ppp-blue-700 hover:underline min-h-[44px] sm:min-h-0 px-1"
              >
                {woOpen ? "Hide" : "Pick a job"}
              </button>
            </div>
            {woOpen && (
              <div className="mt-3">
                <input
                  value={woQuery}
                  onChange={(e) => { setWoQuery(e.target.value); void searchWorkOrders(e.target.value); }}
                  placeholder="Search customer or WO number…"
                  className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
                />
                <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-ppp-charcoal-100 border border-ppp-charcoal-100 rounded-lg">
                  {woBusy && woList.length === 0 && (
                    <li className="px-3 py-3 text-xs text-ppp-charcoal-500 italic">Loading…</li>
                  )}
                  {woList.map((w) => (
                    <li key={w.id}>
                      <button
                        type="button" onClick={() => openWorkOrder(w.id)}
                        className="w-full text-left px-3 py-2.5 min-h-[44px] hover:bg-ppp-blue-50/60 transition-colors touch-manipulation"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-sm font-medium text-ppp-charcoal truncate">{w.customer}</span>
                          {w.unmeasured > 0 ? (
                            <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-ppp-orange-700 text-ppp-orange-50">
                              {w.unmeasured} unmeasured
                            </span>
                          ) : (
                            <span className="shrink-0 text-[10px] text-ppp-green-700">all measured</span>
                          )}
                        </div>
                        <div className="text-[11px] text-ppp-charcoal-500 font-mono">
                          {w.number} · {w.rooms} room{w.rooms === 1 ? "" : "s"}
                        </div>
                      </button>
                    </li>
                  ))}
                  {!woBusy && woList.length === 0 && (
                    <li className="px-3 py-3 text-xs text-ppp-charcoal-500 italic">No open jobs match.</li>
                  )}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {/* Whole-job lookup. First because it's the zero-effort path — the one
          that would actually move the 77% of jobs with nothing measured. */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ppp-charcoal">1 · From an address</h2>
        <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
          Property records give one number for the building, never per-room sizes — so this splits
          it by room type. Always rough, and labelled that way.
        </p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-[2fr_1fr_auto_1fr] gap-2">
          <Field label="Street" value={addr.street} onChange={(v) => setAddr({ ...addr, street: v })} placeholder="12 Maple Ave" />
          <Field label="City" value={addr.city} onChange={(v) => setAddr({ ...addr, city: v })} placeholder="Huntington" />
          <Field label="State" value={addr.state} onChange={(v) => setAddr({ ...addr, state: v })} width="w-20" />
          <Field label="ZIP" value={addr.postalCode} onChange={(v) => setAddr({ ...addr, postalCode: v })} placeholder="11743" />
        </div>
        <button
          type="button" onClick={lookupAddress} disabled={addrBusy || !addr.street.trim()}
          className="mt-3 inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 active:bg-ppp-blue disabled:opacity-50 transition-colors touch-manipulation"
        >
          {addrBusy ? "Looking up…" : "Look up this address"}
        </button>
        {addrNote && <p className="text-[11px] text-ppp-charcoal-600 mt-2">{addrNote}</p>}
        <p className="text-[11px] text-ppp-orange-700 mt-2">
          ⚠ Running on demo property data. Real numbers need an ATTOM / Estated / Rentcast key —
          Zillow&rsquo;s public API is retired.
        </p>
      </section>

      <section>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <h2 className="text-sm font-semibold text-ppp-charcoal">2 · Per room</h2>
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, newRow("New room")])}
            className="text-xs font-medium text-ppp-blue-700 hover:underline min-h-[44px] sm:min-h-0 px-1"
          >
            + Add a room
          </button>
        </div>
        <ul className="space-y-3">
          {rows.map((row) => (
            <RoomRow
              key={row.id} row={row} onPatch={(p) => patch(row.id, p)}
              onPhoto={(f) => onPhoto(row, f)}
              onRemove={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
              canSave={!!wo && !!row.woliId}
              onSave={() => saveRoom(row)}
            />
          ))}
        </ul>
      </section>

      {/* Sticky so the running total stays visible while working down a list —
          the number that answers "is this job sized yet". */}
      {totals.measured > 0 && (
        <div className="sticky bottom-0 bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 pb-safe-sm shadow-lg shadow-ppp-charcoal/10">
          <div className="flex items-baseline justify-between gap-3 flex-wrap text-sm">
            <span className="font-semibold text-ppp-charcoal">
              {totals.measured} of {rows.length} rooms sized
            </span>
            <span className="text-ppp-charcoal-600">
              <strong className="text-ppp-navy font-condensed text-lg">{totals.sqft.toLocaleString()}</strong> sq ft floor
              {totals.wall > 0 && <> · <strong className="text-ppp-navy">{totals.wall.toLocaleString()}</strong> sq ft wall</>}
            </span>
          </div>
          {/* The wall figure is what paint gets ordered against. When it rests
              on an assumed 8 ft ceiling rather than a measured one, say so —
              a real 9 ft ceiling under-orders by 12% and nothing else on this
              screen would ever reveal it. */}
          {totals.assumedCeilings > 0 && totals.wall > 0 && (
            <p className="mt-1.5 text-[11px] text-ppp-orange-700 leading-snug">
              {totals.assumedCeilings === 1 ? "1 room has" : `${totals.assumedCeilings} rooms have`} no ceiling
              height — assuming 8 ft. Enter the real height if it differs.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RoomRow({
  row, onPatch, onPhoto, onRemove, canSave, onSave,
}: {
  row: Row; onPatch: (p: Partial<Row>) => void; onPhoto: (f: File) => void;
  onRemove: () => void; canSave: boolean; onSave: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  /** Live viewfinder is open (before a frame is held). */
  const [cameraOpen, setCameraOpen] = useState(false);
  const [arOpen, setArOpen] = useState(false);
  /** True on Android Chrome (ARCore). Always false on iPhone — Safari ships no
   *  WebXR, so the button routes to the reference-object tool there instead. */
  const arSupported = useArSupported();
  // Tap-to-measure works on a local object URL — the photo never leaves the
  // device for this path, unlike the AI estimate.
  const [tapUrl, setTapUrl] = useState<string | null>(null);

  const [planOpen, setPlanOpen] = useState(false);
  const L = parseFloat(row.lengthFt) || 0;
  const W = parseFloat(row.widthFt) || 0;
  const geo = L > 0 && W > 0 ? geometryFromDimensions({ lengthFt: L, widthFt: W, ceilingFt: parseFloat(row.ceilingFt) || 0 }) : null;
  const gain = L > 0 && W > 0 ? perimeterGainVsSquareGuess({ lengthFt: L, widthFt: W }) : null;

  return (
    <li className="bg-white border border-ppp-charcoal-100 rounded-xl p-4">
      <div className="flex items-center gap-2">
        <input
          value={row.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          aria-label="Room name"
          className="flex-1 min-w-0 min-h-[44px] px-3 py-2 text-base font-semibold text-ppp-charcoal border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
        />
        <button
          type="button" onClick={onRemove} aria-label={`Remove ${row.label}`}
          className="shrink-0 h-11 w-11 sm:h-8 sm:w-8 rounded-lg text-ppp-charcoal-400 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50 touch-manipulation"
        >✕</button>
      </div>

      <div className="mt-3 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <Num label="Length" value={row.lengthFt} onChange={(v) => onPatch({ lengthFt: v })} />
          <Num label="Width" value={row.widthFt} onChange={(v) => onPatch({ widthFt: v })} />
          <Num label="Ceiling" value={row.ceilingFt} onChange={(v) => onPatch({ ceilingFt: v })} placeholderFeet="8" />
        </div>
        {/* Three equal targets, one row, always inside the card. The previous
            version laid these out with a bare `flex` and whitespace-nowrap, so
            on a phone they ran ~457px wide inside a ~358px card: the third one
            was unreachable and the first two touched with no gap between them. */}
        <div className="w-full grid grid-cols-3 gap-2">
          <button
            type="button" onClick={() => fileRef.current?.click()} disabled={row.busy}
            className="flex flex-col items-center justify-center gap-0.5 min-h-[62px] px-1.5 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal hover:bg-ppp-charcoal-50 disabled:opacity-50 touch-manipulation transition-colors"
          >
            <span aria-hidden className="text-lg leading-none">✨</span>
            <span className="text-[11px] font-semibold leading-tight text-center">
              {row.busy ? "Reading…" : "Photo estimate"}
            </span>
          </button>
          <input
            ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ""; }}
          />
          <button
            type="button" onClick={() => (arSupported ? setArOpen(true) : setCameraOpen(true))}
            className="flex flex-col items-center justify-center gap-0.5 min-h-[62px] px-1.5 py-2 rounded-lg border border-ppp-blue-200 bg-ppp-blue-50 text-ppp-blue-800 hover:bg-ppp-blue-100 touch-manipulation transition-colors"
          >
            <span aria-hidden className="text-lg leading-none">📐</span>
            <span className="text-[11px] font-semibold leading-tight text-center">
              {arSupported ? "Measure in AR" : "Measure a wall"}
            </span>
          </button>
          <button
            type="button" onClick={() => setPlanOpen(true)}
            className="flex flex-col items-center justify-center gap-0.5 min-h-[62px] px-1.5 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal hover:bg-ppp-charcoal-50 touch-manipulation transition-colors"
          >
            <span aria-hidden className="text-lg leading-none">🧭</span>
            <span className="text-[11px] font-semibold leading-tight text-center">Walk the room</span>
          </button>

        </div>
      </div>

      {row.planAreaSqft ? (
        <div className="mt-3 text-[11px] text-ppp-charcoal-600 bg-ppp-blue-50 border border-ppp-blue-100 rounded-lg px-3 py-2">
          <strong className="text-ppp-charcoal">{row.planAreaSqft.toLocaleString()} sq ft</strong> floor ·{" "}
          <strong className="text-ppp-charcoal">{row.planPerimeterLf} ft</strong> around, from{" "}
          {row.planWallCount} walls
          <div className="mt-1 text-ppp-charcoal-500">
            Walked, so this is the room&rsquo;s real shape — not a rectangle standing in for it.
          </div>
        </div>
      ) : geo && (
        <div className="mt-3 text-[11px] text-ppp-charcoal-600 bg-[var(--color-surface-muted)] rounded-lg px-3 py-2">
          <strong className="text-ppp-charcoal">{geo.floorAreaSqft.toLocaleString()} sq ft</strong> floor ·{" "}
          <strong className="text-ppp-charcoal">{geo.paintableWallSqft.toLocaleString()} sq ft</strong> paintable wall
          {" · "}perimeter {geo.perimeterLf}′
          {gain && gain.pctDifference !== 0 && (
            <div className="mt-1 text-ppp-charcoal-500">
              This is why both numbers matter: from the area alone the estimator would guess{" "}
              {gain.squareGuessLf}′ of perimeter — {Math.abs(gain.pctDifference)}%{" "}
              {gain.pctDifference > 0 ? "under" : "over"} the real {gain.realLf}′.
            </div>
          )}
        </div>
      )}

      {row.suggestion && (
        <div className="mt-3 rounded-lg border border-ppp-charcoal-100 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ppp-charcoal">{row.suggestion.sqft.toLocaleString()} sq ft</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border ${CONF_TONE[row.suggestion.confidence]}`}>
              {CONFIDENCE_LABEL[row.suggestion.confidence]} · {SOURCE_LABEL[row.suggestion.source]}
            </span>
          </div>
          <p className="text-[11px] text-ppp-charcoal-500 mt-1 leading-snug">{row.suggestion.rationale}</p>
          {row.suggestion.lengthFt && row.suggestion.widthFt && (
            <button
              type="button"
              onClick={() => onPatch({
                lengthFt: String(row.suggestion!.lengthFt),
                widthFt: String(row.suggestion!.widthFt),
                ceilingFt: row.suggestion!.ceilingFt ? String(row.suggestion!.ceilingFt) : row.ceilingFt,
              })}
              className="mt-2 w-full min-h-[44px] rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 active:bg-ppp-blue transition-colors touch-manipulation"
            >
              Put these in the boxes above
            </button>
          )}
        </div>
      )}

      {row.error && (
        <div role="alert" className="mt-3 text-[11px] text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2">
          {row.error}
        </div>
      )}

      {canSave && (
        <button
          type="button" onClick={onSave} disabled={row.busy}
          className={`mt-3 w-full min-h-[44px] rounded-lg text-sm font-semibold transition-colors touch-manipulation disabled:opacity-50 ${
            row.saved
              ? "bg-ppp-green-50 text-ppp-green-700 border border-ppp-green-100"
              : "bg-ppp-green text-ppp-navy hover:bg-ppp-green-600 active:bg-ppp-green"
          }`}
        >
          {row.busy ? "Saving…" : row.saved ? "✓ Saved to this work order" : "Save to work order"}
        </button>
      )}

      {planOpen && (
        <MeasureFloorPlan
          roomLabel={row.label}
          initialCeilingFt={row.ceilingFt}
          onClose={() => setPlanOpen(false)}
          onApply={(r) => {
            onPatch({
              planAreaSqft: r.floorAreaSqft,
              planPerimeterLf: r.perimeterLf,
              planWallCount: r.wallCount,
              ceilingFt: r.ceilingFt ? String(r.ceilingFt) : row.ceilingFt,
              // Clear the rectangle inputs so two conflicting descriptions of
              // the same room can't sit on screen together.
              lengthFt: "", widthFt: "",
              saved: false,
            });
            setPlanOpen(false);
          }}
        />
      )}

      {/* Real AR where the device can do it: anchor a corner, walk, and the
          number keeps up. Android/ARCore only — see measure-ar.tsx. */}
      {arOpen && (
        <MeasureAR
          label={`${row.label} — measure a wall`}
          onClose={() => setArOpen(false)}
          targets={[
            { id: "lengthFt", label: "Length" },
            { id: "widthFt", label: "Width" },
            { id: "ceilingFt", label: "Ceiling" },
          ]}
          onResult={(r, target) => {
            const ft = (Math.round(r.feet * 100) / 100).toString();
            if (target === "lengthFt") onPatch({ lengthFt: ft });
            else if (target === "widthFt") onPatch({ widthFt: ft });
            else if (target === "ceilingFt") onPatch({ ceilingFt: ft });
          }}
        />
      )}

      {/* Live viewfinder first — the camera opens inside the page, there is no
          shutter, and nothing reaches the camera roll. */}
      {cameraOpen && (
        <MeasureLiveCamera
          label={`${row.label} — measure a wall`}
          onClose={() => setCameraOpen(false)}
          onFrame={(dataUrl) => { setCameraOpen(false); setTapUrl(dataUrl); }}
        />
      )}

      {tapUrl && (
        <MeasurePhotoTool
          imageUrl={tapUrl}
          label={row.label}
          onClose={() => setTapUrl(null)}
          // One tap files the number where it belongs. The previous version
          // guessed the next dimension and cycled a counter, so a ceiling
          // measured out of order landed in the width box silently.
          targets={[
            { id: "lengthFt", label: "Length" },
            { id: "widthFt", label: "Width" },
            { id: "ceilingFt", label: "Ceiling" },
          ]}
          onResult={(r: PhotoMeasureResult, target?: string) => {
            const ft = (Math.round(r.feet * 100) / 100).toString();
            if (target === "lengthFt") onPatch({ lengthFt: ft });
            else if (target === "widthFt") onPatch({ widthFt: ft });
            else if (target === "ceilingFt") onPatch({ ceilingFt: ft });
            // Deliberately does NOT close: the calibration belongs to the
            // frame, so length, width and ceiling can all be filed from one
            // setup. The tool's own Done button closes it.
          }}
        />
      )}
    </li>
  );
}

/**
 * A length, entered the way a tape reads it.
 *
 * Stores decimal feet upstream — every consumer already parseFloat()s these —
 * but never shows decimal feet to the person holding the tape. Asking for
 * 12.58 when the tape says 12′ 7″ is a conversion done in someone else's
 * hallway, and 12.7 is a different room.
 */
function Num({ label, value, onChange, placeholderFeet }: { label: string; value: string; onChange: (v: string) => void; placeholderFeet?: string }) {
  const ftIn = fromDecimalFeet(parseFloat(value) || 0);
  return (
    <FeetInchesInput
      compact
      label={label}
      placeholderFeet={placeholderFeet}
      value={ftIn}
      onChange={(v) => {
        const dec = toDecimalFeet(v);
        onChange(dec > 0 ? String(dec) : "");
      }}
    />
  );
}

function Field({ label, value, onChange, placeholder, width }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; width?: string }) {
  return (
    <label className={width ?? "block"}>
      <span className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1">{label}</span>
      <input
        value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
      />
    </label>
  );
}

async function downscale(file: File, maxPx: number): Promise<{ base64: string; mediaType: "image/jpeg" }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  return { base64: (canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? ""), mediaType: "image/jpeg" };
}
