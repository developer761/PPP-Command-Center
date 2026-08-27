"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ModalPortal from "@/components/modal-portal";
import {
  distanceM, formatMetres, metresToFeet, projectToScreen, arConfidence, type Vec3,
} from "@/lib/measure/ar-math";
import { haptic } from "@/lib/measure/haptics";

/**
 * Measuring the way Apple's Measure does it: put a point on a corner, walk, and
 * the number keeps up.
 *
 * This is real AR. The device tracks its own pose in the room — camera feature
 * tracking fused with the IMU, which is where real-world scale comes from — so
 * the two ends of a span do not have to be seen from the same position. That is
 * the whole difference from the reference-object flow.
 *
 * WHERE IT RUNS. Reaching that tracking from a web page needs WebXR. Chrome on
 * Android exposes it through ARCore. Safari on iOS exposes nothing: no WebXR,
 * no ARKit from the browser, at any version. So this mode offers itself only
 * where it genuinely works, and iPhones fall back to the reference-object tool
 * rather than being shown a button that cannot do anything.
 *
 * NO 3D RENDERING. An AR session needs a GL context, but nothing has to be
 * drawn into it — the camera feed is the background and the only graphics are a
 * line and two dots. Those are drawn as SVG in the DOM overlay, positioned by
 * projecting the world points to screen coordinates each frame. That removes
 * shaders, buffers and a whole category of bugs from a feature whose visual
 * output is two dots and a line.
 */

type Phase = "checking" | "unsupported" | "idle" | "running" | "error";

/**
 * Probed once per page, not once per room row — `isSessionSupported` touches
 * the XR runtime and there is one answer per device.
 */
let arProbe: Promise<boolean> | null = null;
function probeAr(): Promise<boolean> {
  if (!arProbe) {
    arProbe =
      typeof navigator === "undefined" || !navigator.xr
        ? Promise.resolve(false)
        : navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
  }
  return arProbe;
}

/**
 * Whether this device can do live AR measuring. null while still unknown.
 *
 * The worker should never have to know whether their phone has ARCore — one
 * "Measure a wall" button routes to whichever tool actually works here.
 */
export function useArSupported(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    probeAr().then((v) => { if (!cancelled) setOk(v); });
    return () => { cancelled = true; };
  }, []);
  return ok;
}

export default function MeasureAR({
  label, targets, onResult, onClose,
}: {
  label: string;
  targets: Array<{ id: string; label: string }>;
  onResult: (r: { feet: number; display: string; confidence: "high" | "medium" | "low"; errorPct: number }, target: string) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);
  const [points, setPoints] = useState<Vec3[]>([]);
  const [saved, setSaved] = useState<Record<string, string>>({});
  /** Set once a surface has actually been found, so the copy can stop saying "looking". */
  const [tracking, setTracking] = useState(false);
  /** Frozen span once two points are down. */
  const [lockedM, setLockedM] = useState<number | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<XRSession | null>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const lineRef = useRef<SVGLineElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  /** The reading, drawn ON the line at its midpoint — where Apple puts it, and
   *  where your eyes already are while you aim. */
  const labelRef = useRef<SVGGElement>(null);
  const labelTextRef = useRef<SVGTextElement>(null);
  const labelBgRef = useRef<SVGRectElement>(null);
  /** Live values the render loop owns — refs, not state: this runs at 60fps and
   *  a setState per frame would drop frames on a mid-range phone. */
  const reticleRef = useRef<Vec3 | null>(null);
  const pointsRef = useRef<Vec3[]>([]);
  useEffect(() => { pointsRef.current = points; }, [points]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof navigator === "undefined" || !navigator.xr) { setPhase("unsupported"); return; }
      try {
        const ok = await navigator.xr.isSessionSupported("immersive-ar");
        if (!cancelled) setPhase(ok ? "idle" : "unsupported");
      } catch {
        if (!cancelled) setPhase("unsupported");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const endSession = useCallback(() => {
    // end() fires the "end" listener, which is what actually stops the loop.
    sessionRef.current?.end().catch(() => {});
    sessionRef.current = null;
  }, []);

  useEffect(() => () => endSession(), [endSession]);

  const start = async () => {
    if (!navigator.xr || !overlayRef.current || !canvasRef.current) return;
    setError(null);
    try {
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        // dom-overlay is what lets the buttons be ordinary HTML on top of the
        // camera feed. Without it the UI would have to be rendered in 3D.
        optionalFeatures: ["dom-overlay"],
        domOverlay: { root: overlayRef.current },
      });
      sessionRef.current = session;
      setPhase("running");
      setPoints([]); setLockedM(null); setTracking(false);

      const gl = canvasRef.current.getContext("webgl", { xrCompatible: true, alpha: true }) as WebGLRenderingContext | null;
      if (!gl) throw new Error("No WebGL context available for the AR session.");
      await gl.makeXRCompatible();
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

      const refSpace = await session.requestReferenceSpace("local");
      const viewerSpace = await session.requestReferenceSpace("viewer");
      const hitSource = await session.requestHitTestSource({ space: viewerSpace });
      if (!hitSource) {
        // Without this the session runs, the camera shows, and the crosshair
        // never finds anything — an indefinite "move the phone slowly" with a
        // permanently disabled button and no way to tell what went wrong.
        await session.end().catch(() => {});
        setPhase("error");
        setError("This device started an AR session but wouldn't provide surface detection.");
        return;
      }

      // The loop's liveness is a local flag, not a ref comparison. A ref can
      // be cleared by any unrelated remount, and because the guard sat BEFORE
      // the reschedule that silently ended the loop after a single frame —
      // camera feed up, crosshair drawn, readout frozen on "—", nothing logged.
      let alive = true;
      session.addEventListener("end", () => {
        alive = false;
        sessionRef.current = null;
        hitSource.cancel();
        setPhase("idle");
      });

      const onFrame = (_t: number, frame: XRFrame) => {
        if (!alive) return;
        session.requestAnimationFrame(onFrame);

        // Where the crosshair meets a real surface.
        let hit: Vec3 | null = null;
        const results = frame.getHitTestResults(hitSource);
        const pose = results.length ? results[0].getPose(refSpace) : null;
        if (pose) {
          const p = pose.transform.position;
          hit = { x: p.x, y: p.y, z: p.z };
        }
        reticleRef.current = hit;
        if (hit) setTracking(true);

        const pts = pointsRef.current;
        // Live distance: from the anchored point to wherever the crosshair is
        // now. This is the behaviour being asked for — it keeps measuring as
        // the phone moves, rather than waiting for a second tap.
        if (readoutRef.current) {
          if (pts.length === 2) {
            readoutRef.current.textContent = formatMetres(distanceM(pts[0], pts[1]));
          } else if (pts.length === 1 && hit) {
            readoutRef.current.textContent = formatMetres(distanceM(pts[0], hit));
          } else {
            readoutRef.current.textContent = hit ? "0″" : "—";
          }
        }

        // Draw the span as SVG by projecting the anchor to screen space.
        const viewerPose = frame.getViewerPose(refSpace);
        const view = viewerPose?.views[0];
        const el = overlayRef.current;
        if (view && el && lineRef.current && dotRef.current) {
          const w = el.clientWidth, h = el.clientHeight;
          const from = pts.length ? pts[0] : null;
          const to = pts.length === 2 ? pts[1] : hit;
          const a = from ? projectToScreen(from, view.transform.inverse.matrix, view.projectionMatrix, w, h) : null;
          const b = to ? projectToScreen(to, view.transform.inverse.matrix, view.projectionMatrix, w, h) : null;
          if (a && b) {
            lineRef.current.setAttribute("x1", String(a.x));
            lineRef.current.setAttribute("y1", String(a.y));
            lineRef.current.setAttribute("x2", String(b.x));
            lineRef.current.setAttribute("y2", String(b.y));
            lineRef.current.style.opacity = "1";
            dotRef.current.setAttribute("cx", String(a.x));
            dotRef.current.setAttribute("cy", String(a.y));
            dotRef.current.style.opacity = "1";

            // Pin the reading to the middle of the span itself.
            const g = labelRef.current, txt = labelTextRef.current, bg = labelBgRef.current;
            if (g && txt && bg && from && to) {
              txt.textContent = formatMetres(distanceM(from, to));
              const w = Math.max(46, txt.textContent.length * 11 + 16);
              bg.setAttribute("x", String(-w / 2));
              bg.setAttribute("width", String(w));
              g.setAttribute("transform", `translate(${(a.x + b.x) / 2}, ${(a.y + b.y) / 2})`);
              g.style.opacity = "1";
            }
          } else {
            lineRef.current.style.opacity = "0";
            dotRef.current.style.opacity = "0";
            if (labelRef.current) labelRef.current.style.opacity = "0";
          }
        }
      };
      session.requestAnimationFrame(onFrame);
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addPoint = () => {
    const p = reticleRef.current;
    if (!p) { haptic("rejected"); return; }
    setPoints((prev) => {
      if (prev.length >= 2) return prev;
      const next = [...prev, p];
      if (next.length === 2) { setLockedM(distanceM(next[0], next[1])); haptic("locked"); }
      else haptic("point");
      return next;
    });
  };

  const undo = () => {
    setLockedM(null);
    setPoints((prev) => prev.slice(0, -1));
  };

  const measurement = lockedM != null ? { m: lockedM, ...arConfidence(lockedM) } : null;

  return (
    <ModalPortal>
      {/* The dom-overlay root. During a session the browser composites this
          over the camera feed; outside one it is an ordinary panel. */}
      <div
        ref={overlayRef}
        className={
          phase === "running"
            ? "fixed inset-0 z-[60] flex flex-col justify-between pointer-events-none"
            : "fixed inset-x-0 top-0 z-[60] h-dvh-full bg-ppp-navy flex flex-col"
        }
      >
        {phase === "running" ? (
          <>
            <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
              <line ref={lineRef} stroke="#8DC442" strokeWidth={4} strokeLinecap="round" style={{ opacity: 0 }} />
              <circle ref={dotRef} r={8} fill="#8DC442" stroke="#fff" strokeWidth={2} style={{ opacity: 0 }} />
              <g ref={labelRef} style={{ opacity: 0 }}>
                <rect ref={labelBgRef} x={-30} y={-15} width={60} height={30} rx={15} fill="rgba(0,0,0,.72)" />
                <text ref={labelTextRef} x={0} y={6} textAnchor="middle"
                  fontSize={17} fontWeight={700} fill="#fff">0</text>
              </g>
            </svg>

            <div className="pointer-events-auto flex items-start justify-between gap-3 p-3">
              <span className="px-3 py-2 rounded-xl bg-black/60 text-white text-[12px] font-medium max-w-[60%]">
                {points.length === 0
                  ? tracking ? "Aim at a corner and press Add" : "Move the phone slowly to find the surface"
                  : points.length === 1 ? "Walk to the other end — it keeps measuring"
                  : "Measured"}
              </span>
              <button
                type="button" onClick={() => { endSession(); onClose(); }}
                className="shrink-0 min-h-[44px] px-4 rounded-xl bg-black/60 text-white text-sm font-semibold touch-manipulation"
              >Done</button>
            </div>

            {/* Crosshair, dead centre, never under a thumb. */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
                <circle cx="32" cy="32" r="17" fill="none" stroke="rgba(0,0,0,.5)" strokeWidth="4" />
                <circle cx="32" cy="32" r="17" fill="none" stroke="#fff" strokeWidth="2" />
                <circle cx="32" cy="32" r="2.5" fill="#EE662E" />
              </svg>
            </div>

            <div
              className="pointer-events-auto px-3 pt-3 space-y-2"
              style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
            >
              <div className="text-center">
                <span
                  ref={readoutRef}
                  className="inline-block px-4 py-1.5 rounded-full bg-black/70 text-white font-condensed text-3xl font-bold tabular-nums"
                >—</span>
              </div>

              {measurement && targets.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    {targets.map((t) => (
                      <button
                        key={t.id} type="button"
                        onClick={() => {
                          const display = formatMetres(measurement.m);
                          onResult({
                            feet: metresToFeet(measurement.m), display,
                            confidence: measurement.confidence, errorPct: measurement.pct,
                          }, t.id);
                          setSaved((s) => ({ ...s, [t.label]: display }));
                          setPoints([]); setLockedM(null);
                        }}
                        className={`flex-1 min-h-[52px] rounded-xl text-sm font-bold touch-manipulation ${
                          saved[t.label] ? "bg-ppp-green-100 text-ppp-navy" : "bg-ppp-green text-ppp-navy"
                        }`}
                      >{saved[t.label] ? `${t.label} ✓` : t.label}</button>
                    ))}
                  </div>
                  <button
                    type="button" onClick={() => { setPoints([]); setLockedM(null); }}
                    className="w-full min-h-[44px] rounded-xl bg-black/60 text-white text-sm font-semibold touch-manipulation"
                  >Measure another</button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button" onClick={undo} disabled={points.length === 0}
                    className="shrink-0 min-h-[56px] px-4 rounded-xl bg-black/60 text-white text-sm font-semibold disabled:opacity-30 touch-manipulation"
                  >⟲</button>
                  <button
                    type="button" onClick={addPoint} disabled={!tracking}
                    className="flex-1 min-h-[56px] rounded-xl bg-ppp-blue text-ppp-navy text-base font-bold disabled:opacity-40 touch-manipulation"
                  >
                    {points.length === 0 ? "Add first point" : "Add end point"}
                  </button>
                </div>
              )}
              {Object.keys(saved).length > 0 && (
                <p className="text-center text-white text-[11px] bg-black/50 rounded-full px-3 py-1">
                  Saved {Object.entries(saved).map(([k, v]) => `${k} ${v}`).join(" · ")}
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="text-white font-semibold text-sm truncate">{label}</div>
              <button
                type="button" onClick={onClose} aria-label="Close"
                className="shrink-0 h-11 w-11 rounded-lg text-white/80 hover:bg-white/10 text-xl touch-manipulation"
              >✕</button>
            </div>
            <div className="flex-1 flex items-center justify-center p-6 text-center">
              <div className="max-w-sm">
                {phase === "checking" && <p className="text-white/70 text-sm">Checking this phone for AR…</p>}
                {phase === "unsupported" && (
                  <>
                    <p className="text-white font-semibold text-sm">This phone can&apos;t do live AR in the browser</p>
                    <p className="text-white/70 text-[12px] mt-2 leading-snug">
                      Live AR measuring needs WebXR, which Chrome on Android supports and Safari on
                      iPhone does not — at any version. On an iPhone, use “Measure a wall”, which
                      gets its scale from a door or outlet in the shot instead.
                    </p>
                  </>
                )}
                {phase === "error" && (
                  <>
                    <p className="text-white font-semibold text-sm">AR couldn&apos;t start</p>
                    <p className="text-white/70 text-[12px] mt-2 leading-snug">{error}</p>
                    <button
                      type="button" onClick={start}
                      className="mt-4 min-h-[48px] px-5 rounded-xl bg-ppp-blue text-ppp-navy text-sm font-bold touch-manipulation"
                    >Try again</button>
                  </>
                )}
                {phase === "idle" && (
                  <>
                    <p className="text-white font-semibold text-base">Point, tap, walk</p>
                    <p className="text-white/70 text-[12px] mt-2 leading-snug">
                      Put the crosshair on one corner and press Add. Walk to the other end — the
                      measurement keeps up as you go. Press Add again to lock it in.
                    </p>
                    <button
                      type="button" onClick={start}
                      className="mt-5 w-full min-h-[56px] rounded-xl bg-ppp-blue text-ppp-navy text-base font-bold touch-manipulation"
                    >Start measuring</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
        <canvas ref={canvasRef} className="hidden" aria-hidden />
      </div>
    </ModalPortal>
  );
}
