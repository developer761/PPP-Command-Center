"use client";

import { useCallback, useEffect, useState } from "react";
import MeasureAR, { probeAr } from "@/components/measure-ar";
import MeasureGround from "@/components/measure-ground";
import MeasureFloorPlan from "@/components/measure-floor-plan";
import MeasureLiveCamera from "@/components/measure-live-camera";
import MeasurePhotoTool from "@/components/measure-photo-tool";
import ModalPortal from "@/components/modal-portal";
import { formatFeetInches } from "@/lib/measure/photo-scale";

/**
 * Measure first. Decide where it goes after.
 *
 * The previous version was built around ROOMS: pick a job, pick a room, pick
 * one of three capture methods, and the number landed in a Length/Width/Ceiling
 * box on that row. Every one of those was a decision standing between someone
 * and the thing they came to do, and Karan's verdict was fair — confusing, and
 * nothing like the tool it was meant to feel like.
 *
 * Apple's Measure has no setup at all. You open it and you measure. What you do
 * with the number is a separate thought, and it comes second. So:
 *
 *     Measure  →  a number  →  what was it?  →  (optionally) which job
 *
 * Nothing is required except the measuring. A number with no home is still
 * worth keeping — on a job site you often measure four walls before deciding
 * which room they belong to — so measurements persist locally and can be
 * assigned later, or never.
 */

type Assignment = {
  workOrderId: string;
  workOrderNumber: string;
  woliId: string;
  roomLabel: string;
  dimension: "lengthFt" | "widthFt" | "ceilingFt";
};

type Measurement = {
  id: string;
  /** A single span. Zero for a walked room, which has no one length. */
  feet: number;
  display: string;
  takenAt: number;
  note: string;
  assignment: Assignment | null;
  /**
   * A walked room carries a floor area and a real perimeter instead of a span.
   * Kept distinct because an L-shaped room has more wall than any length x
   * width implies, and collapsing it to a single number throws that away.
   */
  room?: { sqft: number; perimeterLf: number; ceilingFt: number | null } | null;
  saving?: boolean;
  error?: string | null;
};

type WorkOrderOption = { id: string; number: string; customer: string; rooms: number; unmeasured: number };
type RoomOption = { woliId: string; label: string };

const STORE_KEY = "ppp.measure.session";

/**
 * Ask for Motion & Orientation while still inside the user's tap.
 *
 * Resolves either way — a refusal is handled by the tool, which explains what
 * to turn back on. Never throws, so a browser without the API (everything but
 * iOS) simply falls through.
 */
async function ensureOrientationPermission(): Promise<void> {
  try {
    const Ctor = (typeof DeviceOrientationEvent !== "undefined" ? DeviceOrientationEvent : undefined) as
      (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }) | undefined;
    if (Ctor && typeof Ctor.requestPermission === "function") await Ctor.requestPermission();
  } catch {
    /* declined, or already answered — the tool reports it either way */
  }
}

const DIMENSIONS: Array<{ id: Assignment["dimension"]; label: string }> = [
  { id: "lengthFt", label: "Length" },
  { id: "widthFt", label: "Width" },
  { id: "ceilingFt", label: "Ceiling" },
];

export default function MeasureTool() {
  const [items, setItems] = useState<Measurement[]>([]);
  const [tool, setTool] = useState<"ar" | "ground" | null>(null);
  const [walkOpen, setWalkOpen] = useState(false);
  /** The reference-object path: a held frame, for anything not on the floor. */
  const [cameraOpen, setCameraOpen] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  /** The measurement whose "where does this go?" sheet is open. */
  const [assigning, setAssigning] = useState<Measurement | null>(null);

  // Measurements are taken in someone's house and are expensive to retake, so
  // a reload or a backgrounded tab must not lose them.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setItems(JSON.parse(raw) as Measurement[]);
    } catch { /* private mode — session-only is still fine */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, 50))); } catch { /* ignore */ }
  }, [items]);

  /**
   * Open whichever measuring tool this phone can actually run.
   *
   * Awaited rather than read from state: the capability probe is async, and
   * reading it mid-flight resolved to "no AR" and quietly opened the fallback
   * on a phone that supports the real thing.
   */
  const startMeasuring = useCallback(async () => {
    setOpening(true);
    try {
      const ar = await probeAr();
      if (!ar) {
        // iOS only grants Motion & Orientation from a user GESTURE, and this
        // click is the gesture. Requesting it inside the tool — which mounts
        // asynchronously — silently fails, which is why the tool used to carry
        // its own "Start measuring" button purely to have something to tap.
        // Asking here lets the tool open straight onto the camera.
        await ensureOrientationPermission();
      }
      setTool(ar ? "ar" : "ground");
    } finally {
      setOpening(false);
    }
  }, []);

  const record = useCallback((feet: number, display: string) => {
    const m: Measurement = {
      id: `${Date.now()}-${Math.round(feet * 1000)}`,
      feet, display, takenAt: Date.now(), note: "", assignment: null,
    };
    setItems((prev) => [m, ...prev]);
    // Straight into "what was that?" — asking while the wall is still in front
    // of you beats asking later, when four measurements look identical.
    setAssigning(m);
  }, []);

  const patch = useCallback((id: string, next: Partial<Measurement>) => {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, ...next } : m)));
    setAssigning((a) => (a && a.id === id ? { ...a, ...next } : a));
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] uppercase tracking-wider font-semibold text-ppp-blue-700">Measure</p>
        <h1 className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy mt-1">
          Measure a wall
        </h1>
        <p className="text-sm text-ppp-charcoal-600 mt-1 leading-snug">
          Point, tap the ends, done. Say what it was afterwards.
        </p>
      </div>

      <button
        type="button"
        onClick={startMeasuring}
        disabled={opening}
        className="w-full min-h-[72px] rounded-2xl bg-ppp-blue text-ppp-navy text-lg font-bold shadow-lg shadow-ppp-blue/20 active:bg-ppp-blue-400 disabled:opacity-60 transition-colors touch-manipulation flex items-center justify-center gap-2"
      >
        <span aria-hidden className="text-2xl leading-none">📐</span>
        {opening ? "Opening…" : "Measure"}
      </button>

      {/* A whole room is a different job from a single wall, so it gets its own
          action rather than a third choice buried inside the measuring tool. */}
      <button
        type="button"
        onClick={() => setWalkOpen(true)}
        className="w-full min-h-[52px] rounded-xl border border-ppp-charcoal-200 bg-white text-ppp-charcoal text-sm font-semibold touch-manipulation flex items-center justify-center gap-2"
      >
        <span aria-hidden>🧭</span> Walk a whole room
      </button>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-ppp-charcoal">
            Measurements{items.length ? ` (${items.length})` : ""}
          </h2>
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => { if (confirm("Clear all measurements?")) setItems([]); }}
              className="text-[11px] text-ppp-charcoal-500 underline min-h-[44px] touch-manipulation"
            >
              Clear all
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <p className="mt-2 text-sm text-ppp-charcoal-500 bg-[var(--color-surface-muted)] border border-ppp-charcoal-100 rounded-xl px-4 py-6 text-center leading-snug">
            Nothing measured yet. Tap <strong className="text-ppp-charcoal">Measure</strong> and point at
            a wall — you can decide which job it belongs to afterwards.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {items.map((m) => (
              <li key={m.id} className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="font-condensed text-2xl font-bold text-ppp-navy tabular-nums shrink-0">
                    {m.display}
                  </span>
                  <span className="flex-1 min-w-0 text-[12px] text-ppp-charcoal-600 truncate">
                    {m.assignment
                      ? `${m.assignment.roomLabel} · ${m.room ? "whole room" : DIMENSIONS.find((d) => d.id === m.assignment!.dimension)?.label} · WO ${m.assignment.workOrderNumber}`
                      : m.note || (m.room ? `${m.room.perimeterLf} ft around` : "Not assigned yet")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAssigning(m)}
                    className="shrink-0 min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 text-xs font-semibold text-ppp-charcoal touch-manipulation"
                  >
                    {m.assignment ? "Change" : "Add to…"}
                  </button>
                </div>
                {m.error && <p className="mt-1.5 text-[11px] text-ppp-orange-700">{m.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {tool === "ar" && (
        <MeasureAR
          label="Measure a wall"
          targets={[]}   /* assignment happens after, not inside the tool */
          onClose={() => setTool(null)}
          onResult={(r) => record(r.feet, r.display)}
        />
      )}
      {tool === "ground" && (
        <MeasureGround
          label="Measure a wall"
          targets={[]}
          onClose={() => setTool(null)}
          // The floor-plane method cannot measure anything vertical, so a
          // ceiling height hands off to the reference-object tool rather than
          // being quietly unavailable.
          onNeedVertical={() => { setTool(null); setCameraOpen(true); }}
          onResult={(r) => record(r.feet, r.display)}
        />
      )}
      {cameraOpen && (
        <MeasureLiveCamera
          label="Measure something vertical"
          onClose={() => setCameraOpen(false)}
          onFrame={(dataUrl) => { setCameraOpen(false); setFrameUrl(dataUrl); }}
        />
      )}
      {frameUrl && (
        <MeasurePhotoTool
          imageUrl={frameUrl}
          label="Measure something vertical"
          targets={[]}
          onClose={() => setFrameUrl(null)}
          onResult={(r) => { setFrameUrl(null); record(r.feet, r.display); }}
        />
      )}

      {walkOpen && (
        <MeasureFloorPlan
          roomLabel="Walk the room"
          onClose={() => setWalkOpen(false)}
          onApply={(r) => {
            const m: Measurement = {
              id: `${Date.now()}-room`,
              feet: 0,
              display: `${r.floorAreaSqft.toLocaleString()} sq ft`,
              takenAt: Date.now(),
              note: "",
              assignment: null,
              room: { sqft: r.floorAreaSqft, perimeterLf: r.perimeterLf, ceilingFt: r.ceilingFt },
            };
            setItems((prev) => [m, ...prev]);
            setWalkOpen(false);
            setAssigning(m);
          }}
        />
      )}

      {assigning && (
        <AssignSheet
          measurement={assigning}
          onClose={() => setAssigning(null)}
          onPatch={patch}
        />
      )}
    </div>
  );
}

/**
 * "What was that, and whose is it?" — asked after the number exists.
 *
 * Every part is skippable. A measurement with no job attached is still a
 * measurement, and forcing an assignment would push people back into choosing a
 * work order before they can measure, which is the exact shape of the thing
 * this replaced.
 */
function AssignSheet({
  measurement, onClose, onPatch,
}: {
  measurement: Measurement;
  onClose: () => void;
  onPatch: (id: string, next: Partial<Measurement>) => void;
}) {
  const [dimension, setDimension] = useState<Assignment["dimension"]>(measurement.assignment?.dimension ?? "lengthFt");
  const [note, setNote] = useState(measurement.note);
  const [wo, setWo] = useState<WorkOrderOption | null>(
    measurement.assignment
      ? { id: measurement.assignment.workOrderId, number: measurement.assignment.workOrderNumber, customer: "", rooms: 0, unmeasured: 0 }
      : null
  );
  const [query, setQuery] = useState("");
  const [woList, setWoList] = useState<WorkOrderOption[]>([]);
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [woliId, setWoliId] = useState(measurement.assignment?.woliId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch("/api/admin/measure", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return res.json();
  }, []);

  useEffect(() => {
    if (wo) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const d = await call({ action: "workOrders", query });
        if (!cancelled) setWoList((d.workOrders ?? []).slice(0, 25));
      } catch { /* the picker is optional; a failure must not block saving */ }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, wo, call]);

  useEffect(() => {
    if (!wo) { setRooms([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const d = await call({ action: "rooms", workOrderId: wo.id });
        if (!cancelled) setRooms(d.rooms ?? []);
      } catch { /* leave the list empty; "keep it unassigned" still works */ }
    })();
    return () => { cancelled = true; };
  }, [wo, call]);

  const save = async () => {
    if (!wo || !woliId) {
      // Keeping it without a job is a legitimate outcome, not a failure.
      onPatch(measurement.id, { note, assignment: null, error: null });
      onClose();
      return;
    }
    setBusy(true); setError(null);
    try {
      // A walked room saves its real area AND its real perimeter. Sending it as
      // a single dimension would let the server re-derive the perimeter from a
      // rectangle, which is exactly the number walking the room exists to beat.
      const payload = measurement.room
        ? {
            action: "save", woliId, workOrderId: wo.id,
            sqft: measurement.room.sqft,
            perimeterLf: measurement.room.perimeterLf,
            ceilingFt: measurement.room.ceilingFt ?? undefined,
            // "dimensions" — someone measured the room, which is literally what
            // walking it is. "plan" is not in MeasureSource, and the save route
            // casts the value through unchecked, so it would have reached the
            // database as an invalid enum rather than being rejected here.
            source: "dimensions", confidence: "high",
          }
        : {
            action: "save", woliId, workOrderId: wo.id,
            [dimension]: measurement.feet,
            source: "manual", confidence: "high",
          };
      const d = await call(payload);
      if (!d.ok) throw new Error(d.message ?? d.error ?? "Save failed");
      onPatch(measurement.id, {
        note,
        error: null,
        assignment: {
          workOrderId: wo.id,
          workOrderNumber: wo.number,
          woliId,
          roomLabel: rooms.find((r) => r.woliId === woliId)?.label ?? "Room",
          dimension,
        },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Portalled: the page shell carries `.animate-fade-up`, and a live transform
    // makes an ancestor the containing block for `fixed` — so this sheet would
    // open off-screen whenever the list was scrolled. Caught by the guard test,
    // which is the fourth time that rule has paid for itself.
    <ModalPortal>
    <div className="fixed inset-x-0 top-0 z-50 h-dvh-full flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ppp-navy/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative z-10 w-full sm:max-w-md max-h-dvh-sheet bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3 shrink-0">
          <div>
            <div className="font-condensed text-3xl font-bold text-ppp-navy tabular-nums">{measurement.display}</div>
            <p className="text-[11px] text-ppp-charcoal-500">Where does this go?</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="h-11 w-11 rounded-lg text-ppp-charcoal-400 text-xl touch-manipulation">✕</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {measurement.room ? (
            <p className="text-[12px] text-ppp-charcoal-600 bg-ppp-blue-50 border border-ppp-blue-100 rounded-lg px-3 py-2 leading-snug">
              A whole room — {measurement.room.sqft.toLocaleString()} sq ft of floor and{" "}
              {measurement.room.perimeterLf} ft around. Both are saved, so an L-shaped room keeps
              the extra wall a rectangle would miss.
            </p>
          ) : (
          <div>
            <span className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1.5">
              What did you measure?
            </span>
            <div className="flex gap-2">
              {DIMENSIONS.map((d) => (
                <button key={d.id} type="button" onClick={() => setDimension(d.id)}
                  aria-pressed={dimension === d.id}
                  className={`flex-1 min-h-[48px] rounded-lg text-sm font-semibold border transition-colors touch-manipulation ${
                    dimension === d.id
                      ? "bg-ppp-blue text-ppp-navy border-ppp-blue"
                      : "bg-white text-ppp-charcoal border-ppp-charcoal-200"
                  }`}
                >{d.label}</button>
              ))}
            </div>
          </div>
          )}

          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1">
              Note (optional)
            </span>
            <input
              value={note} onChange={(e) => setNote(e.target.value)} maxLength={80}
              placeholder='e.g. "north wall, behind the door"'
              className="w-full min-h-[48px] px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg"
            />
          </label>

          <div>
            <span className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1.5">
              Add to a job (optional)
            </span>
            {wo ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm font-semibold text-ppp-charcoal truncate">
                    WO {wo.number}{wo.customer ? ` · ${wo.customer}` : ""}
                  </span>
                  <button type="button" onClick={() => { setWo(null); setWoliId(""); }}
                    className="min-h-[44px] px-3 text-xs underline text-ppp-blue-700 touch-manipulation">Change</button>
                </div>
                {rooms.length > 0 ? (
                  <select
                    value={woliId} onChange={(e) => setWoliId(e.target.value)}
                    className="w-full min-h-[48px] px-3 text-base border border-ppp-charcoal-200 rounded-lg bg-white"
                  >
                    <option value="">— pick a room —</option>
                    {rooms.map((r) => <option key={r.woliId} value={r.woliId}>{r.label}</option>)}
                  </select>
                ) : (
                  <p className="text-[11px] text-ppp-charcoal-500">No rooms on this work order.</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search work orders…"
                  className="w-full min-h-[48px] px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg"
                />
                <ul className="max-h-40 overflow-y-auto divide-y divide-ppp-charcoal-100 border border-ppp-charcoal-100 rounded-lg">
                  {woList.map((w) => (
                    <li key={w.id}>
                      <button type="button" onClick={() => setWo(w)}
                        className="w-full text-left px-3 py-2.5 min-h-[48px] hover:bg-ppp-blue-50/60 touch-manipulation">
                        <span className="block text-sm font-medium text-ppp-charcoal truncate">{w.customer}</span>
                        <span className="block text-[11px] text-ppp-charcoal-500">
                          WO {w.number} · {w.unmeasured} of {w.rooms} rooms unmeasured
                        </span>
                      </button>
                    </li>
                  ))}
                  {woList.length === 0 && (
                    <li className="px-3 py-3 text-[12px] text-ppp-charcoal-500">No matches.</li>
                  )}
                </ul>
              </div>
            )}
          </div>

          {error && <p className="text-[12px] text-ppp-orange-700 leading-snug">{error}</p>}
        </div>

        <div className="shrink-0 border-t border-ppp-charcoal-100 px-5 pt-3 pb-safe-sm flex gap-2">
          <button type="button" onClick={onClose}
            className="min-h-[52px] px-4 rounded-xl border border-ppp-charcoal-200 text-sm font-semibold text-ppp-charcoal-600 touch-manipulation">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="flex-1 min-h-[52px] rounded-xl bg-ppp-green text-ppp-navy text-sm font-bold disabled:opacity-50 touch-manipulation">
            {busy ? "Saving…" : wo && woliId ? "Save to this room" : "Keep it, no job"}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
