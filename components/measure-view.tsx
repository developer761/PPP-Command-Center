"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { geometryFromDimensions, perimeterGainVsSquareGuess } from "@/lib/measure/geometry";
import { CONFIDENCE_LABEL, SOURCE_LABEL, type MeasureSuggestion, type MeasureConfidence } from "@/lib/measure/types";

/**
 * Capture square footage for the rooms on a work order.
 *
 * Built mobile-first because that is literally where it happens: someone is
 * standing in the room, on a phone, probably one-handed, possibly holding a
 * tape. Every control is thumb-reachable and ≥44px, every input is text-base
 * so iOS doesn't zoom on focus, and the primary path (type two numbers) works
 * with no network round-trip and no camera permission.
 *
 * The ordering of the four methods is deliberate and matches how much effort
 * each asks of the person: tape first, because it is both the most accurate
 * and the fastest for someone already in the room.
 */

export type MeasureRoom = {
  woliId: string;
  label: string;
  /** What Salesforce already has, if anything. */
  sfSqft: number;
  /** What the Command Center has stored (a previous capture). */
  savedSqft: number | null;
  savedSource: string | null;
  savedConfidence: string | null;
  surfaces: string[];
};

type Props = {
  workOrderId: string;
  workOrderNumber: string | null;
  customerName: string | null;
  rooms: MeasureRoom[];
  address: { street: string; city: string; state: string; postalCode: string } | null;
  historyByRoom: Record<string, MeasureSuggestion>;
};

const CONF_TONE: Record<MeasureConfidence, string> = {
  high: "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100",
  medium: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100",
  low: "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100",
};

export default function MeasureView({
  workOrderId, workOrderNumber, customerName, rooms, address, historyByRoom,
}: Props) {
  const router = useRouter();
  const [saved, setSaved] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const r of rooms) if (r.savedSqft) m[r.woliId] = r.savedSqft;
    return m;
  });
  const [addressBusy, setAddressBusy] = useState(false);
  const [addressNote, setAddressNote] = useState<string | null>(null);
  const [addressSuggestions, setAddressSuggestions] = useState<Record<string, MeasureSuggestion>>({});

  const effective = (r: MeasureRoom) => saved[r.woliId] ?? r.savedSqft ?? r.sfSqft ?? 0;
  const missing = rooms.filter((r) => !effective(r)).length;
  const done = rooms.length - missing;

  async function lookupAddress() {
    if (!address) return;
    setAddressBusy(true);
    setAddressNote(null);
    try {
      const res = await fetch("/api/admin/measure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "address",
          workOrderId,
          address,
          rooms: rooms.map((r) => ({ id: r.woliId, label: r.label })),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setAddressNote(data.message ?? "Couldn't look that address up.");
      } else {
        setAddressSuggestions(data.byRoom ?? {});
        setAddressNote(
          `Found ${Number(data.property?.buildingSqft ?? 0).toLocaleString()} sq ft on record. These are rough splits — check any that look off.`
        );
      }
    } catch {
      setAddressNote("Couldn't reach the property lookup.");
    } finally {
      setAddressBusy(false);
    }
  }

  return (
    <div className="space-y-4 pb-28">
      <div>
        <Link
          href={`/dashboard/materials/${encodeURIComponent(workOrderId)}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ppp-blue-700 hover:underline"
        >
          <span aria-hidden>←</span> Back to work order
        </Link>
        <h1 className="mt-2 text-xl sm:text-2xl font-condensed font-bold text-ppp-navy">Measure rooms</h1>
        <p className="text-xs text-ppp-charcoal-500 mt-1">
          {customerName ?? "(unknown customer)"}
          {workOrderNumber ? ` · WO ${workOrderNumber}` : ""}
        </p>
      </div>

      {/* Progress — the one number that says whether ordering will work. */}
      <div className={`rounded-xl border px-4 py-3 ${missing === 0 ? "bg-ppp-green-50 border-ppp-green-100" : "bg-ppp-orange-50 border-ppp-orange-100"}`}>
        <div className="text-sm font-semibold text-ppp-charcoal">
          {missing === 0
            ? `All ${rooms.length} rooms measured — paint quantities will calculate.`
            : `${done} of ${rooms.length} rooms measured`}
        </div>
        {missing > 0 && (
          <div className="text-[11px] text-ppp-charcoal-600 mt-0.5">
            The {missing === 1 ? "room" : `${missing} rooms`} without a number can&apos;t be sized, so the
            supplier order asks the vendor to confirm those quantities.
          </div>
        )}
      </div>

      {/* Whole-job shortcut. Deliberately first: it costs the worker nothing
          and fills every empty room at once, which on most jobs is the entire
          problem. */}
      {address?.street ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ppp-charcoal">Fill every room from the address</h2>
              <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 break-words">
                {address.street}, {address.city} {address.state} — rough starting points you can correct.
              </p>
            </div>
            <button
              type="button"
              onClick={lookupAddress}
              disabled={addressBusy}
              className="shrink-0 inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 active:bg-ppp-blue disabled:opacity-60 transition-colors touch-manipulation"
            >
              {addressBusy ? "Looking up…" : "Look up"}
            </button>
          </div>
          {addressNote && <p className="text-[11px] text-ppp-charcoal-600 mt-2">{addressNote}</p>}
        </div>
      ) : null}

      <ul className="space-y-3">
        {rooms.map((room) => (
          <RoomCard
            key={room.woliId}
            room={room}
            workOrderId={workOrderId}
            current={effective(room)}
            history={historyByRoom[room.woliId] ?? null}
            addressSuggestion={addressSuggestions[room.woliId] ?? null}
            onSaved={(sqft) => {
              setSaved((s) => ({ ...s, [room.woliId]: sqft }));
              // The order screen reads the same table — refresh so a worker who
              // walks straight there sees the quantities already updated.
              router.refresh();
            }}
          />
        ))}
      </ul>
    </div>
  );
}

/* ─── One room ─────────────────────────────────────────────────────────── */

function RoomCard({
  room, workOrderId, current, history, addressSuggestion, onSaved,
}: {
  room: MeasureRoom;
  workOrderId: string;
  current: number;
  history: MeasureSuggestion | null;
  addressSuggestion: MeasureSuggestion | null;
  onSaved: (sqft: number) => void;
}) {
  const [mode, setMode] = useState<"idle" | "tape" | "photo">("idle");
  const [len, setLen] = useState("");
  const [wid, setWid] = useState("");
  const [ceil, setCeil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoSuggestion, setPhotoSuggestion] = useState<MeasureSuggestion | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const L = parseFloat(len) || 0;
  const W = parseFloat(wid) || 0;
  const live = L > 0 && W > 0 ? geometryFromDimensions({ lengthFt: L, widthFt: W, ceilingFt: parseFloat(ceil) || 0 }) : null;
  const gain = L > 0 && W > 0 ? perimeterGainVsSquareGuess({ lengthFt: L, widthFt: W }) : null;

  async function save(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/measure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", woliId: room.woliId, workOrderId, roomLabel: room.label, ...payload }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.message ?? data.error ?? "Couldn't save that.");
        return;
      }
      onSaved(data.sqft);
      setMode("idle");
      setPhotoSuggestion(null);
    } catch {
      setError("Couldn't save — check your signal and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onPhoto(file: File) {
    setBusy(true);
    setError(null);
    try {
      // Downscale on the device. A modern phone photo is 4–8MB, which is slow
      // to upload on a job site and no more useful to the model than 1024px.
      const resized = await downscale(file, 1024);
      const res = await fetch("/api/admin/measure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "photo",
          woliId: room.woliId,
          roomLabel: room.label,
          imageBase64: resized.base64,
          mediaType: resized.mediaType,
          knownHintFt: parseFloat(ceil) || null,
          knownHintLabel: parseFloat(ceil) ? "the ceiling height" : null,
        }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.message ?? data.error ?? "Couldn't read that photo.");
      else setPhotoSuggestion(data.suggestion as MeasureSuggestion);
    } catch {
      setError("Couldn't process that photo.");
    } finally {
      setBusy(false);
    }
  }

  const suggestions = [photoSuggestion, addressSuggestion, history].filter(Boolean) as MeasureSuggestion[];

  return (
    <li className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ppp-charcoal text-sm">{room.label}</div>
          {room.surfaces.length > 0 && (
            <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{room.surfaces.join(" · ")}</div>
          )}
        </div>
        <div className="shrink-0 text-right">
          {current > 0 ? (
            <>
              <div className="font-condensed text-lg font-bold text-ppp-navy">{current.toLocaleString()}</div>
              <div className="text-[10px] text-ppp-charcoal-500">sq ft</div>
            </>
          ) : (
            <span className="inline-flex items-center px-2 py-1 rounded text-[10px] font-semibold bg-ppp-orange-700 text-ppp-orange-50">
              Not measured
            </span>
          )}
        </div>
      </div>

      {mode === "idle" && (
        <div className="px-4 pb-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode("tape")}
            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 active:bg-ppp-blue transition-colors touch-manipulation"
          >
            📏 Measure it
          </button>
          <button
            type="button"
            onClick={() => { setMode("photo"); fileRef.current?.click(); }}
            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal text-sm font-medium hover:bg-ppp-charcoal-50 transition-colors touch-manipulation"
          >
            📷 Use a photo
          </button>
          {/* capture="environment" opens the rear camera directly on a phone
              rather than the photo library — one tap fewer in the room. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPhoto(f); e.target.value = ""; }}
          />
        </div>
      )}

      {mode === "tape" && (
        <div className="px-4 pb-4 border-t border-ppp-charcoal-100 pt-3">
          <div className="flex gap-2 flex-wrap">
            <NumField label="Length (ft)" value={len} onChange={setLen} autoFocus />
            <NumField label="Width (ft)" value={wid} onChange={setWid} />
            <NumField label="Ceiling (ft)" value={ceil} onChange={setCeil} placeholder="8" />
          </div>
          {live && (
            <div className="mt-3 text-[11px] text-ppp-charcoal-600 bg-[var(--color-surface-muted)] rounded-lg px-3 py-2">
              <strong className="text-ppp-charcoal">{live.floorAreaSqft.toLocaleString()} sq ft</strong> floor ·{" "}
              {live.paintableWallSqft.toLocaleString()} sq ft of wall
              {gain && gain.pctDifference !== 0 && (
                <div className="mt-1 text-ppp-charcoal-500">
                  Both numbers matter — this room&apos;s real perimeter is {gain.realLf}′, and guessing
                  from the area alone would be {Math.abs(gain.pctDifference)}%{" "}
                  {gain.pctDifference > 0 ? "low" : "high"}.
                </div>
              )}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={!live || busy}
              onClick={() => live && save({
                sqft: live.floorAreaSqft, lengthFt: L, widthFt: W,
                ceilingFt: parseFloat(ceil) || null, source: "dimensions", confidence: "high",
              })}
              className="flex-1 min-h-[44px] rounded-lg bg-ppp-green text-ppp-navy text-sm font-semibold hover:bg-ppp-green-600 active:bg-ppp-green disabled:opacity-50 transition-colors touch-manipulation"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="min-h-[44px] px-4 rounded-lg border border-ppp-charcoal-200 text-sm text-ppp-charcoal-600 touch-manipulation"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {busy && mode === "photo" && (
        <div className="px-4 pb-3 text-xs text-ppp-charcoal-500 italic">Reading the photo…</div>
      )}

      {suggestions.length > 0 && (
        <div className="px-4 pb-4 space-y-2 border-t border-ppp-charcoal-100 pt-3">
          {suggestions.map((s, i) => (
            <div key={`${s.source}-${i}`} className="rounded-lg border border-ppp-charcoal-100 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-semibold text-ppp-charcoal">
                  {s.sqft.toLocaleString()} sq ft
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border ${CONF_TONE[s.confidence]}`}>
                  {CONFIDENCE_LABEL[s.confidence]} · {SOURCE_LABEL[s.source]}
                </span>
              </div>
              <p className="text-[11px] text-ppp-charcoal-500 mt-1 leading-snug">{s.rationale}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => save({
                  sqft: s.sqft, lengthFt: s.lengthFt ?? null, widthFt: s.widthFt ?? null,
                  ceilingFt: s.ceilingFt ?? null, source: s.source, confidence: s.confidence, suggestion: s,
                })}
                className="mt-2 w-full min-h-[44px] rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 active:bg-ppp-blue disabled:opacity-50 transition-colors touch-manipulation"
              >
                Use this
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div role="alert" className="mx-4 mb-3 text-[11px] text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
    </li>
  );
}

function NumField({
  label, value, onChange, placeholder, autoFocus,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <label className="flex-1 min-w-[92px]">
      <span className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1">{label}</span>
      <input
        // decimal keypad, not the full keyboard — one-handed entry on site.
        type="number"
        inputMode="decimal"
        step="0.1"
        min="0"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        // text-base keeps iOS from zooming the page on focus.
        className="w-full px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
      />
    </label>
  );
}

/** Shrink a phone photo before upload. 4–8MB over site LTE is the difference
 *  between "instant" and "broken". */
async function downscale(file: File, maxPx: number): Promise<{ base64: string; mediaType: "image/jpeg" }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  return { base64: dataUrl.split(",")[1] ?? "", mediaType: "image/jpeg" };
}
