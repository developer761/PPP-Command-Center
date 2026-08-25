"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SCALE_REFERENCES, scaleFromReference, estimateError, formatFeetInches,
  type Point, type ScaledMeasurement,
} from "@/lib/measure/photo-scale";
import ModalPortal from "@/components/modal-portal";

/**
 * Tap two points on something you know, then two on what you want.
 *
 * The interaction is deliberately the same shape as Apple's Measure — place a
 * point, place a second, read the distance — because that is the part people
 * already understand. What differs is where the scale comes from: ARKit gets it
 * from LiDAR and motion, which Safari cannot reach, so this gets it from an
 * object in the photo whose real size is fixed by building code.
 *
 * Points are stored in NATURAL image coordinates, not screen pixels, so a
 * rotated phone, a pinch-zoom or a different device doesn't move a tap that was
 * already placed.
 */

type Stage = "reference" | "target" | "done";

export type PhotoMeasureResult = {
  inches: number;
  feet: number;
  display: string;
  confidence: "high" | "medium" | "low";
  errorPct: number;
};

export default function MeasurePhotoTool({
  imageUrl, label, onResult, onClose,
}: {
  imageUrl: string;
  label: string;
  onResult: (r: PhotoMeasureResult) => void;
  onClose: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState<Stage>("reference");
  const [refPts, setRefPts] = useState<Point[]>([]);
  const [tgtPts, setTgtPts] = useState<Point[]>([]);
  const [refId, setRefId] = useState(SCALE_REFERENCES[0].id);
  const [customInches, setCustomInches] = useState("");

  const reference = SCALE_REFERENCES.find((r) => r.id === refId)!;
  const needsCustom = reference.inches === 0;
  const referenceInches = needsCustom ? parseFloat(customInches) || 0 : reference.inches;

  /** Screen tap → natural image coordinates. */
  const toNatural = useCallback((clientX: number, clientY: number): Point | null => {
    const img = imgRef.current;
    if (!img || !natural) return null;
    const box = img.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * natural.w;
    const y = ((clientY - box.top) / box.height) * natural.h;
    if (x < 0 || y < 0 || x > natural.w || y > natural.h) return null;
    return { x, y };
  }, [natural]);

  const handleTap = (e: React.MouseEvent | React.TouchEvent) => {
    const t = "touches" in e ? e.changedTouches[0] : e;
    const pt = toNatural(t.clientX, t.clientY);
    if (!pt) return;
    if (stage === "reference") {
      const next = [...refPts, pt].slice(-2);
      setRefPts(next);
      if (next.length === 2) setStage("target");
    } else if (stage === "target") {
      const next = [...tgtPts, pt].slice(-2);
      setTgtPts(next);
      if (next.length === 2) setStage("done");
    }
  };

  const measurement: ScaledMeasurement | null =
    refPts.length === 2 && tgtPts.length === 2 && referenceInches > 0
      ? scaleFromReference({
          referenceA: refPts[0], referenceB: refPts[1], referenceInches,
          targetA: tgtPts[0], targetB: tgtPts[1],
        })
      : null;

  const err = refPts.length === 2 && tgtPts.length === 2
    ? estimateError({ referenceA: refPts[0], referenceB: refPts[1], targetA: tgtPts[0], targetB: tgtPts[1] })
    : null;

  const reset = () => { setRefPts([]); setTgtPts([]); setStage("reference"); };

  // Escape closes — a full-screen overlay with no keyboard exit is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pct = (p: Point) => natural ? { left: `${(p.x / natural.w) * 100}%`, top: `${(p.y / natural.h) * 100}%` } : {};

  return (
    // Portalled: page shells carry `.animate-fade-up`, whose live transform
    // makes an ancestor the containing block for `fixed` — so this would open
    // off-screen when scrolled down. Caught by the R4.11 guard test, which is
    // the third time that rule has paid for itself.
    <ModalPortal>
    <div className="fixed inset-0 z-50 bg-ppp-navy/95 flex flex-col">
      <div className="flex items-center justify-between gap-3 px-4 py-3 shrink-0">
        <div className="min-w-0">
          <div className="text-white font-semibold text-sm truncate">{label}</div>
          <div className="text-white/70 text-[11px]">
            {stage === "reference" ? `Tap both ends of the ${reference.label.toLowerCase()}`
              : stage === "target" ? "Now tap both ends of what you're measuring"
              : "Measurement ready"}
          </div>
        </div>
        <button
          type="button" onClick={onClose} aria-label="Close"
          className="shrink-0 h-11 w-11 rounded-lg text-white/80 hover:bg-white/10 text-xl touch-manipulation"
        >✕</button>
      </div>

      {/* The photo. Points sit in an overlay positioned by percentage, so they
          stay put through rotation and resize. */}
      <div className="flex-1 min-h-0 flex items-center justify-center px-2 overflow-hidden">
        <div className="relative max-h-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={imageUrl}
            alt={`Photo of ${label}`}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onClick={handleTap}
            className="max-h-[60vh] w-auto rounded-lg cursor-crosshair touch-manipulation select-none"
            draggable={false}
          />
          {natural && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${natural.w} ${natural.h}`} preserveAspectRatio="none">
              {refPts.length === 2 && (
                <line x1={refPts[0].x} y1={refPts[0].y} x2={refPts[1].x} y2={refPts[1].y}
                  stroke="#8DC442" strokeWidth={natural.w / 200} strokeLinecap="round" />
              )}
              {tgtPts.length === 2 && (
                <line x1={tgtPts[0].x} y1={tgtPts[0].y} x2={tgtPts[1].x} y2={tgtPts[1].y}
                  stroke="#2BAAE1" strokeWidth={natural.w / 200} strokeLinecap="round" />
              )}
            </svg>
          )}
          {refPts.map((p, i) => (
            <span key={`r${i}`} style={pct(p)}
              className="absolute -translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-ppp-green border-2 border-white shadow" />
          ))}
          {tgtPts.map((p, i) => (
            <span key={`t${i}`} style={pct(p)}
              className="absolute -translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-ppp-blue border-2 border-white shadow" />
          ))}
        </div>
      </div>

      <div className="shrink-0 bg-white rounded-t-2xl p-4 space-y-3 max-h-[45vh] overflow-y-auto">
        {stage === "reference" && (
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1">
              What are you scaling from?
            </label>
            <select
              value={refId} onChange={(e) => { setRefId(e.target.value); reset(); }}
              className="w-full px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg min-h-[44px]"
            >
              {SCALE_REFERENCES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}{r.inches > 0 ? ` — ${formatFeetInches(r.inches)}` : ""}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-ppp-charcoal-500 mt-1.5 leading-snug">{reference.hint}</p>
            {needsCustom && (
              <input
                type="number" inputMode="decimal" value={customInches}
                onChange={(e) => setCustomInches(e.target.value)}
                placeholder="How many inches?"
                className="mt-2 w-full px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg"
              />
            )}
          </div>
        )}

        {measurement && err && (
          <div className={`rounded-xl border px-4 py-3 ${
            err.confidence === "high" ? "bg-ppp-green-50 border-ppp-green-100"
            : err.confidence === "medium" ? "bg-ppp-blue-50 border-ppp-blue-100"
            : "bg-ppp-orange-50 border-ppp-orange-100"}`}>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="font-condensed text-3xl font-bold text-ppp-navy">{measurement.display}</span>
              <span className="text-[11px] text-ppp-charcoal-600">± about {err.pct}%</span>
            </div>
            <div className="text-[11px] text-ppp-charcoal-600 mt-1">
              {referenceInches}″ reference measured {measurement.referencePx}px; your span measured{" "}
              {measurement.targetPx}px.
            </div>
            {err.note && <div className="text-[11px] text-ppp-orange-700 mt-1.5 leading-snug">{err.note}</div>}
          </div>
        )}

        <div className="flex gap-2">
          {stage !== "reference" && (
            <button type="button" onClick={reset}
              className="min-h-[44px] px-4 rounded-lg border border-ppp-charcoal-200 text-sm font-medium text-ppp-charcoal-600 touch-manipulation">
              Start over
            </button>
          )}
          <button
            type="button"
            disabled={!measurement}
            onClick={() => measurement && err && onResult({
              inches: measurement.inches, feet: measurement.feet, display: measurement.display,
              confidence: err.confidence, errorPct: err.pct,
            })}
            className="flex-1 min-h-[44px] rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 active:bg-ppp-blue disabled:opacity-50 transition-colors touch-manipulation"
          >
            {measurement ? `Use ${measurement.display}` : "Tap 4 points to measure"}
          </button>
        </div>

        <p className="text-[10px] text-ppp-charcoal-400 leading-snug">
          Most accurate when the reference and what you&rsquo;re measuring are on the same wall and
          you shot it straight on. Photographing from a corner reads short.
        </p>
      </div>
    </div>
    </ModalPortal>
  );
}
