"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SCALE_REFERENCES, scaleFromReference, estimateError, formatFeetInches,
  type Point, type ScaledMeasurement,
} from "@/lib/measure/photo-scale";
import ModalPortal from "@/components/modal-portal";
import {
  CALIBRATION_RECTS, solveHomography, measureOnPlane, rectWorldCorners,
  calibrationResidual, type Homography,
} from "@/lib/measure/homography";

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

/**
 * Two ways to get the scale, and the difference is large enough to matter.
 *
 * "line" scales by the ratio of two pixel lengths. Fast — two taps — and
 * correct only when the wall is parallel to the camera.
 *
 * "plane" tags the four corners of a known rectangle and recovers the full
 * perspective transform, after which any point on that wall measures correctly
 * from any angle. Two more taps.
 *
 * Measured on a moderate oblique view: a 12ft wall came out exact under
 * "plane" and 28.6% SHORT under "line". Job sites have furniture in them, so
 * shooting square to the wall is often impossible — which makes the extra two
 * taps the difference between a usable number and under-buying the paint by a
 * quarter.
 */
type Method = "plane" | "line";

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
  // Perspective correction is the DEFAULT: it costs two extra taps and removes
  // the single largest error source. "line" stays for when there's no
  // rectangle in shot.
  const [method, setMethod] = useState<Method>("plane");
  const [rectId, setRectId] = useState(CALIBRATION_RECTS[0].id);
  const [rectW, setRectW] = useState("");
  const [rectH, setRectH] = useState("");

  const reference = SCALE_REFERENCES.find((r) => r.id === refId)!;
  const needsCustom = reference.inches === 0;
  const referenceInches = needsCustom ? parseFloat(customInches) || 0 : reference.inches;

  const rect = CALIBRATION_RECTS.find((r) => r.id === rectId)!;
  const rectCustom = rect.widthIn === 0;
  const rectWidthIn = rectCustom ? parseFloat(rectW) || 0 : rect.widthIn;
  const rectHeightIn = rectCustom ? parseFloat(rectH) || 0 : rect.heightIn;
  const refPointsNeeded = method === "plane" ? 4 : 2;

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
      const next = [...refPts, pt].slice(-refPointsNeeded);
      setRefPts(next);
      if (next.length === refPointsNeeded) setStage("target");
    } else if (stage === "target") {
      const next = [...tgtPts, pt].slice(-2);
      setTgtPts(next);
      if (next.length === 2) setStage("done");
    }
  };

  // Perspective path: recover the wall plane from the four tapped corners.
  const homography: Homography | null =
    method === "plane" && refPts.length === 4 && rectWidthIn > 0 && rectHeightIn > 0
      ? solveHomography(refPts, rectWorldCorners(rectWidthIn, rectHeightIn))
      : null;

  // Fitted to those corners, so a large residual means the taps weren't a
  // rectangle's corners — a stray tap, or corners entered out of order. That
  // mistake silently ruins every later measurement, so it has to be caught.
  const residual = homography ? calibrationResidual(homography, refPts, rectWidthIn, rectHeightIn) : null;
  const calibrationOff = residual != null && residual > 1;

  const planeInches =
    homography && tgtPts.length === 2 ? measureOnPlane(homography, tgtPts[0], tgtPts[1]) : null;

  const measurement: ScaledMeasurement | null =
    method === "plane"
      ? planeInches != null
        ? { inches: planeInches, feet: planeInches / 12, display: formatFeetInches(planeInches), referencePx: 0, targetPx: 0 }
        : null
      : refPts.length === 2 && tgtPts.length === 2 && referenceInches > 0
        ? scaleFromReference({
            referenceA: refPts[0], referenceB: refPts[1], referenceInches,
            targetA: tgtPts[0], targetB: tgtPts[1],
          })
        : null;

  const err =
    method === "plane"
      ? measurement
        ? {
            // Perspective is corrected, so what's left is tap precision — and
            // a bad calibration, which dominates everything if present.
            pct: calibrationOff ? 25 : 2,
            confidence: (calibrationOff ? "low" : "high") as "high" | "medium" | "low",
            note: calibrationOff
              ? "Those four taps don't form a rectangle — check you went round the corners in order, then start over."
              : null,
          }
        : null
      : refPts.length === 2 && tgtPts.length === 2
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
            {stage === "reference"
              ? method === "plane"
                ? `Tap the 4 corners of the ${rect.label.split(" (")[0].toLowerCase()}, in order — ${refPts.length}/4`
                : `Tap both ends of the ${reference.label.toLowerCase()}`
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
              {method === "line" && refPts.length === 2 && (
                <line x1={refPts[0].x} y1={refPts[0].y} x2={refPts[1].x} y2={refPts[1].y}
                  stroke="#8DC442" strokeWidth={natural.w / 200} strokeLinecap="round" />
              )}
              {method === "plane" && refPts.length >= 2 && (
                <polygon
                  points={refPts.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="rgba(141,196,66,0.18)"
                  stroke="#8DC442"
                  strokeWidth={natural.w / 250}
                  strokeLinejoin="round"
                />
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
            {/* Method first: it changes what the taps mean. */}
            <div className="inline-flex rounded-lg border border-ppp-charcoal-200 overflow-hidden mb-3 w-full">
              {([
                ["plane", "Accurate", "4 taps on a rectangle — works from any angle"],
                ["line", "Quick", "2 taps — only if you're square to the wall"],
              ] as const).map(([m, title, sub]) => (
                <button
                  key={m} type="button"
                  onClick={() => { setMethod(m); reset(); }}
                  aria-pressed={method === m}
                  className={`flex-1 px-3 py-2 min-h-[44px] text-left transition-colors touch-manipulation ${
                    method === m ? "bg-ppp-blue text-ppp-navy" : "bg-white text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                  }`}
                >
                  <span className="block text-xs font-semibold">{title}</span>
                  <span className="block text-[10px] opacity-80 leading-tight">{sub}</span>
                </button>
              ))}
            </div>

            {method === "plane" ? (
              <>
                <label className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1">
                  What rectangle are you tapping?
                </label>
                <select
                  value={rectId} onChange={(e) => { setRectId(e.target.value); reset(); }}
                  className="w-full px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg min-h-[44px]"
                >
                  {CALIBRATION_RECTS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <p className="text-[11px] text-ppp-charcoal-500 mt-1.5 leading-snug">{rect.hint}</p>
                {rectCustom && (
                  <div className="mt-2 flex gap-2">
                    <input type="number" inputMode="decimal" value={rectW} onChange={(e) => setRectW(e.target.value)}
                      placeholder="Width in inches"
                      className="flex-1 px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg" />
                    <input type="number" inputMode="decimal" value={rectH} onChange={(e) => setRectH(e.target.value)}
                      placeholder="Height in inches"
                      className="flex-1 px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg" />
                  </div>
                )}
                <p className="text-[11px] text-ppp-charcoal-500 mt-2 leading-snug">
                  Anything you measure on that same wall will be right, however far off-square you
                  were standing.
                </p>
              </>
            ) : (
              <>
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
              </>
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
              {method === "plane"
                ? `Corrected for camera angle using the ${rectWidthIn}″ × ${rectHeightIn}″ rectangle.`
                : `${referenceInches}″ reference measured ${measurement.referencePx}px; your span measured ${measurement.targetPx}px.`}
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
            {measurement
              ? `Use ${measurement.display}`
              : method === "plane"
                ? `Tap ${refPts.length < 4 ? `${4 - refPts.length} more corner${4 - refPts.length === 1 ? "" : "s"}` : "2 points to measure"}`
                : "Tap 4 points to measure"}
          </button>
        </div>

        <p className="text-[10px] text-ppp-charcoal-400 leading-snug">
          {method === "plane"
            ? "Everything you measure must be on the SAME wall as the rectangle. The angle you shot from doesn't matter."
            : "Only accurate if you shot square to the wall — from an angle this reads short. Switch to Accurate if there's a door in frame."}
        </p>
      </div>
    </div>
    </ModalPortal>
  );
}
