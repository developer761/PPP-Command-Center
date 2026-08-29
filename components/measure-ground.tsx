"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ModalPortal from "@/components/modal-portal";
import {
  groundPoint, groundPointSnapped, groundDistance, averageAttitude, attitudeSpread,
  groundAimQuality, depressionAngle, calibrateHeight, type Attitude, type Vec2,
} from "@/lib/measure/ground-plane";
import {
  grayWindow, rowGradientProfile, findDominantEdge, pixelOffsetToAngle, DEFAULT_V_FOV,
} from "@/lib/measure/edge-snap";
import FeetInchesInput, {
  EMPTY_FT_IN, toDecimalFeet, fromDecimalFeet, type FeetInchesValue,
} from "@/components/feet-inches-input";
import { formatMetres, metresToFeet } from "@/lib/measure/ar-math";
import { haptic } from "@/lib/measure/haptics";

/**
 * Measuring on an iPhone, with no AR available at all.
 *
 * Safari exposes neither WebXR nor ARKit, so the phone's POSITION in the room is
 * unavailable — and recovering it by integrating the accelerometer drifts by
 * inches within seconds. But attitude is a different thing entirely: pitch and
 * roll are referenced to gravity, so they are absolute and never accumulate
 * error, and Safari does report them.
 *
 * So this uses only what does not drift. Hold the phone at a known height, aim
 * the crosshair where a wall meets the floor, and trigonometry gives the
 * distance: d = h / tan(depression). Aim at one corner, then the other, and the
 * gap between those floor points is the wall.
 *
 * ACCURACY, MEASURED RATHER THAN CLAIMED (see the tests). A single instantaneous
 * reading puts a 12ft wall out by ~2.1in median, ~4.3in at p90 — the tail being
 * what quietly buys the wrong paint. Holding the crosshair still for half a
 * second and averaging the burst takes that to ~0.34in median, ~0.84in p90.
 * Hence the hold: it is not decoration, it is the difference between a usable
 * number and a plausible one.
 *
 * The error that averaging CANNOT remove is the holding height, which scales
 * every distance proportionally — 2in wrong in 60in is 3.3% on everything. That
 * is why the height is calibrated against a known length rather than guessed,
 * and why the calibration is remembered per person.
 *
 * WHAT IT CANNOT DO: the target has to be on the floor, so this measures along
 * the floor. Ceiling heights and spans up a wall need the reference-object tool.
 */

const HEIGHT_KEY = "ppp.measure.holdHeightM";
const BURST_MS = 600;

export default function MeasureGround({
  label, targets, onResult, onClose, onNeedVertical,
}: {
  label: string;
  targets: Array<{ id: string; label: string }>;
  onResult: (r: { feet: number; display: string; confidence: "high" | "medium" | "low"; errorPct: number }, target: string) => void;
  onClose: () => void;
  /** Escape hatch to the reference-object tool for anything not on the floor. */
  onNeedVertical?: () => void;
}) {
  const [phase, setPhase] = useState<"intro" | "live" | "denied" | "unsupported">("intro");
  const [detail, setDetail] = useState<string | null>(null);
  // 5ft exactly: a plausible chest height AND one that reads back as a round
  // number. 1.5m displays as 4'11", which looks like something went wrong.
  const [heightM, setHeightM] = useState<number>(1.524);
  const [heightDraft, setHeightDraft] = useState<FeetInchesValue>(EMPTY_FT_IN);
  const [points, setPoints] = useState<Vec2[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [lockedM, setLockedM] = useState<number | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [calibrating, setCalibrating] = useState(false);
  const [knownDraft, setKnownDraft] = useState<FeetInchesValue>(EMPTY_FT_IN);
  const [aimWarning, setAimWarning] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const attitudeRef = useRef<Attitude | null>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  /** Live aim feedback, written straight to the DOM from the sensor handler.
   *  Telling someone the aim was too flat AFTER a held burst wastes the hold;
   *  saying so while they are still aiming costs nothing. */
  const aimStatusRef = useRef<HTMLSpanElement>(null);
  /** Which way the already-anchored corner lies, in plain words. Without FOV we
   *  cannot draw it on the picture, but we can always say left or right. */
  const bearingHintRef = useRef<HTMLSpanElement>(null);
  const pointsRef = useRef<Vec2[]>([]);
  const heightRef = useRef(1.524);
  /**
   * Edge snapping. The detector reads the live frame and reports where the
   * wall-floor junction sits relative to the centre of the screen; that offset
   * becomes a pitch correction applied to every sample.
   *
   * Aim placement is the largest remaining error now that tremor is averaged
   * out and height is calibrated: a 20px misplacement costs about 4in on a 12ft
   * wall, against the 0.34in the burst-average achieves. Snapping takes that to
   * roughly a quarter inch even with the assumed field of view 20% wrong.
   */
  const snapRef = useRef(0);
  const snapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [snapped, setSnapped] = useState(false);
  /**
   * The detected line, drawn where it actually is.
   *
   * Showing the lock as a bar through the crosshair would make a WRONG lock —
   * a rug edge, a shadow, a skirting board — look exactly like a right one. The
   * whole safety of snapping rests on the worker being able to see what it
   * grabbed, so the line is drawn at the row it was found on.
   */
  const snapLineRef = useRef<HTMLDivElement>(null);
  useEffect(() => { pointsRef.current = points; }, [points]);
  useEffect(() => { heightRef.current = heightM; }, [heightM]);

  // Remember the calibrated holding height — it belongs to the person, not the job.
  useEffect(() => {
    try {
      const v = parseFloat(localStorage.getItem(HEIGHT_KEY) ?? "");
      if (v > 0.6 && v < 2.4) { setHeightM(v); setHeightDraft(fromDecimalFeet(metresToFeet(v))); }
      else setHeightDraft(fromDecimalFeet(metresToFeet(1.524)));
    } catch { /* private mode — the default stands */ }
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** Samples accumulated during a hold. Non-null only while capturing. */
  const burstRef = useRef<Attitude[] | null>(null);
  const lockedRef = useRef<number | null>(null);
  useEffect(() => { lockedRef.current = lockedM; }, [lockedM]);

  /**
   * Everything hangs off the sensor event rather than a render loop.
   *
   * Polling the latest attitude from requestAnimationFrame resamples the sensor
   * — duplicating readings when it is slower than the frame rate and dropping
   * them when it is faster — and rAF is suspended outright whenever the tab is
   * not visible. Reading each event as it arrives takes exactly the samples the
   * hardware produced, which is what the burst average wants.
   */
  const onOrientation = useCallback((e: DeviceOrientationEvent) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const a: Attitude = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    attitudeRef.current = a;
    if (burstRef.current) burstRef.current.push(a);

    const here = groundPointSnapped(a, heightRef.current, snapRef.current);
    const pts = pointsRef.current;

    const out = readoutRef.current;
    if (out) {
      if (lockedRef.current != null) out.textContent = formatMetres(lockedRef.current);
      else out.textContent =
        pts.length === 1 && here ? formatMetres(groundDistance(pts[0], here))
        : here ? "0″" : "—";
    }

    const status = aimStatusRef.current;
    if (status && lockedRef.current == null) {
      const q = groundAimQuality(depressionAngle(a), heightRef.current);
      status.textContent = q.usable ? "" : (q.reason ?? "");
      status.style.opacity = q.usable ? "0" : "1";
    }

    // After the first corner, say which way the other one is. Purely from the
    // bearing difference, so it needs no lens model and cannot mislead.
    const hint = bearingHintRef.current;
    if (hint) {
      if (pts.length === 1 && here) {
        const a1 = Math.atan2(pts[0].x, pts[0].y);
        const a2 = Math.atan2(here.x, here.y);
        let d = ((a2 - a1) * 180) / Math.PI;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        hint.textContent = Math.abs(d) < 3 ? "same spot as the first corner"
          : `first corner is ${Math.round(Math.abs(d))}° to your ${d > 0 ? "left" : "right"}`;
        hint.style.opacity = "1";
      } else {
        hint.style.opacity = "0";
      }
    }
  }, []);

  useEffect(() => () => {
    stopStream();
    window.removeEventListener("deviceorientation", onOrientation);
  }, [stopStream, onOrientation]);

  /**
   * Look for the wall–floor junction near the centre of the frame.
   *
   * On a timer at ~12Hz, not once per rendered frame. The correction only has
   * to be current while the phone is being held still — which is exactly when a
   * measurement is taken — and running edge detection 60 times a second would
   * burn battery on a job site to no benefit.
   *
   * A stale correction paired with a fresh attitude would be wrong while the
   * phone is swinging, so the snap is dropped the moment the detector loses
   * confidence rather than being allowed to persist.
   */
  useEffect(() => {
    if (phase !== "live") return;
    const canvas = snapCanvasRef.current ?? document.createElement("canvas");
    snapCanvasRef.current = canvas;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let stop = false;

    const tick = () => {
      if (stop) return;
      const v = videoRef.current;
      if (!ctx || !v || !v.videoWidth) return;
      // Downscale hard: the junction is a long low-frequency edge, so detail
      // beyond a few hundred pixels adds cost and noise, not accuracy.
      const W = 240;
      const H = Math.max(8, Math.round((v.videoHeight / v.videoWidth) * W));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      try {
        ctx.drawImage(v, 0, 0, W, H);
      } catch {
        return;   // frame not ready
      }
      // 55% of the frame height. Narrower keeps the detector honest but makes
      // it refuse a junction that is plainly visible on screen; this band still
      // bounds how far a snap can pull the aim, via maxDelta below.
      const winH = Math.max(9, Math.round(H * 0.55));
      const winW = Math.max(3, Math.round(W * 0.6));
      const win = grayWindow(ctx.getImageData(0, 0, W, H).data, W, H, winW, winH);
      if (!win) return;
      const hit = findDominantEdge(rowGradientProfile(win.gray, win.width, win.height), 2.2);
      const hide = () => { if (snapLineRef.current) snapLineRef.current.style.opacity = "0"; };
      if (!hit) { snapRef.current = 0; setSnapped(false); hide(); return; }
      // Angle per pixel is set by the FULL frame, never the crop window.
      const delta = pixelOffsetToAngle(hit.offsetPx, H, DEFAULT_V_FOV);
      // A correction larger than the window could justify means the detector
      // has locked onto something else — a doorway, a counter, a shadow.
      const maxDelta = pixelOffsetToAngle(winH / 2, H, DEFAULT_V_FOV);
      if (Math.abs(delta) > maxDelta) { snapRef.current = 0; setSnapped(false); hide(); return; }
      snapRef.current = delta;
      setSnapped(true);

      // Put the indicator on the row it was actually found on. The feed is
      // object-cover, so the video is scaled to fill and cropped — the visible
      // height of the whole frame is videoH * that scale, not the container's.
      const bar = snapLineRef.current;
      if (bar) {
        const box = v.getBoundingClientRect();
        const scale = Math.max(box.width / v.videoWidth, box.height / v.videoHeight);
        const shownFrameH = v.videoHeight * scale;
        bar.style.transform = `translateY(${(hit.offsetPx / H) * shownFrameH}px)`;
        bar.style.opacity = "1";
      }
    };

    const id = window.setInterval(tick, 80);
    return () => { stop = true; window.clearInterval(id); snapRef.current = 0; };
  }, [phase]);

  /** Both permissions must be asked from the tap, not on mount — iOS requires it. */
  const start = async () => {
    setDetail(null);
    try {
      type PermCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };
      const Ctor = (typeof DeviceOrientationEvent !== "undefined" ? DeviceOrientationEvent : undefined) as PermCtor | undefined;
      if (!Ctor) { setPhase("unsupported"); setDetail("This browser reports no orientation sensors."); return; }
      if (typeof Ctor.requestPermission === "function") {
        const res = await Ctor.requestPermission();
        if (res !== "granted") { setPhase("denied"); setDetail("Motion & Orientation access was declined."); return; }
      }
      window.addEventListener("deviceorientation", onOrientation);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setPhase("live");
    } catch (err) {
      setPhase("denied");
      setDetail(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Collect a burst while the crosshair is held on the corner, then commit the
   * average. One instantaneous sample carries the whole hand tremor.
   */
  const capture = (onPoint: (p: Vec2, spreadDeg: number) => void) => {
    if (capturing) return;
    burstRef.current = [];
    setCapturing(true);
    setAimWarning(null);
    window.setTimeout(() => {
      const samples = burstRef.current ?? [];
      burstRef.current = null;
      setCapturing(false);
      const avg = averageAttitude(samples);
      if (!avg || samples.length < 5) {
        haptic("rejected");
        setAimWarning("Couldn't read the phone's tilt — hold it still and try again.");
        return;
      }
      // Refuse a flat aim before it becomes a number: error goes as h/sin²θ, so
      // near the horizon a degree of tremor is worth feet, not inches.
      const quality = groundAimQuality(depressionAngle(avg), heightRef.current);
      if (!quality.usable) { haptic("rejected"); setAimWarning(quality.reason); return; }
      const p = groundPointSnapped(avg, heightRef.current, snapRef.current);
      if (!p) { haptic("rejected"); setAimWarning("Aim down at the floor where the wall meets it."); return; }
      onPoint(p, attitudeSpread(samples));
    }, BURST_MS);
  };

  const addPoint = () => capture((p, spread) => {
    if (spread > 2) setAimWarning("That was a wobbly hold — check the number, or measure it again.");
    setPoints((prev) => {
      if (prev.length >= 2) return prev;
      const next = [...prev, p];
      if (next.length === 2) { setLockedM(groundDistance(next[0], next[1])); haptic("locked"); }
      else haptic("point");
      return next;
    });
  });

  /** Calibration: measure something of known length and solve for the height. */
  const finishCalibration = () => {
    const trueFt = toDecimalFeet(knownDraft);
    if (!(trueFt > 0) || lockedM == null) return;
    const corrected = calibrateHeight(heightM, lockedM, trueFt * 0.3048);
    if (!corrected) {
      setAimWarning("That doesn't work out to a height anyone could hold a phone at — check the length you entered.");
      return;
    }
    setHeightM(corrected);
    setHeightDraft(fromDecimalFeet(metresToFeet(corrected)));
    try { localStorage.setItem(HEIGHT_KEY, String(corrected)); } catch { /* private mode */ }
    setCalibrating(false); setPoints([]); setLockedM(null); setKnownDraft(EMPTY_FT_IN);
  };

  const applyTypedHeight = (v: FeetInchesValue) => {
    setHeightDraft(v);
    const ft = toDecimalFeet(v);
    if (ft > 0) {
      const m = ft * 0.3048;
      if (m > 0.6 && m < 2.4) {
        setHeightM(m);
        try { localStorage.setItem(HEIGHT_KEY, String(m)); } catch { /* private mode */ }
      }
    }
  };

  const heightFtIn = formatMetres(heightM);

  return (
    <ModalPortal>
      <div className="fixed inset-x-0 top-0 z-[60] h-dvh-full bg-black flex flex-col">
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 bg-ppp-navy">
          <div className="min-w-0">
            <div className="text-white font-semibold text-sm truncate">{label}</div>
            <div className="text-white/70 text-[11px]">
              {phase !== "live" ? "Measure along the floor"
                : calibrating ? "Calibrating — measure something you know"
                : points.length === 0 ? `Holding at ${heightFtIn} · aim where the wall meets the floor`
                : points.length === 1 ? "Now the other corner"
                : "Measured"}
            </div>
          </div>
          <button
            type="button" onClick={() => { stopStream(); onClose(); }}
            aria-label={Object.keys(saved).length > 0 ? "Done" : "Close"}
            className={`shrink-0 min-h-[44px] rounded-lg touch-manipulation ${
              Object.keys(saved).length > 0 ? "px-4 bg-ppp-green text-ppp-navy text-sm font-bold" : "w-11 text-white/80 text-xl"
            }`}
          >{Object.keys(saved).length > 0 ? "Done" : "✕"}</button>
        </div>

        <div className="relative flex-1 min-h-[140px] bg-black">
          <video ref={videoRef} playsInline muted autoPlay
            className={`absolute inset-0 w-full h-full object-cover ${phase === "live" ? "" : "opacity-0"}`} />

          {phase === "live" && (
            <>
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden>
                  {capturing && (
                    <circle cx="38" cy="38" r="30" fill="none" stroke="#8DC442" strokeWidth="4"
                      strokeDasharray="188" strokeDashoffset="0" opacity="0.9">
                      <animate attributeName="stroke-dashoffset" from="188" to="0" dur="0.6s" fill="freeze" />
                    </circle>
                  )}
                  <circle cx="38" cy="38" r="20" fill="none" stroke="rgba(0,0,0,.5)" strokeWidth="4" />
                  <circle cx="38" cy="38" r="20" fill="none"
                    stroke={snapped ? "#8DC442" : "#fff"} strokeWidth={snapped ? 3 : 2} />

                  <circle cx="38" cy="38" r="2.5" fill="#EE662E" />
                </svg>
              </div>
              {/* The detected floor line, at the row it was found on. */}
              <div
                ref={snapLineRef} aria-hidden
                className="opacity-0 absolute left-0 right-0 top-1/2 h-0 border-t-2 border-ppp-green pointer-events-none transition-opacity duration-150 shadow-[0_0_0_1px_rgba(0,0,0,.45)]"
              />
              <p className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/60 text-white text-[11px] text-center max-w-[92%] pointer-events-none">
                {capturing ? "Hold still…"
                  : snapped ? "Locked on the floor line — press Add"
                  : "Put the crosshair where the wall meets the floor"}
              </p>
              {/* A fixed scrim, not a themed fill. This sits on live video, which
                  has no theme of its own — and every themed 600-900 token flips
                  role in dark mode, so white on one of those is unreadable half
                  the time. Black at 78% is legible over any room. */}
              <span
                ref={aimStatusRef} className="opacity-0 absolute top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/[.78] text-ppp-orange-100 text-[11px] font-semibold text-center max-w-[92%] pointer-events-none transition-opacity"
              />
              <span
                ref={bearingHintRef} className="opacity-0 absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/55 text-white/90 text-[11px] text-center pointer-events-none transition-opacity"
              />
            </>
          )}

          {phase !== "live" && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              <div className="max-w-sm">
                {phase === "intro" && (
                  <>
                    <p className="text-white font-semibold text-base">Point at the floor, not the wall</p>
                    <p className="text-white/70 text-[12px] mt-2 leading-snug">
                      Your iPhone can&apos;t do live AR in the browser, but it does know which way is
                      down — exactly, and without drifting. Aim where a wall meets the floor, hold
                      still for a moment, then do the other corner.
                    </p>
                    <div className="mt-4 text-left">
                      <FeetInchesInput
                        label="How high are you holding the phone?"
                        value={heightDraft}
                        onChange={applyTypedHeight}
                      />
                      <p className="text-white/50 text-[11px] mt-1.5 leading-snug">
                        Roughly chest height. You can measure something you know afterwards and it
                        will work the exact height out for you.
                      </p>
                    </div>
                    <button type="button" onClick={start}
                      className="mt-4 w-full min-h-[56px] rounded-xl bg-ppp-blue text-ppp-navy text-base font-bold touch-manipulation">
                      Start measuring
                    </button>
                  </>
                )}
                {(phase === "denied" || phase === "unsupported") && (
                  <>
                    <p className="text-white font-semibold text-sm">
                      {phase === "denied" ? "Permission declined" : "Sensors unavailable"}
                    </p>
                    <p className="text-white/70 text-[12px] mt-2 leading-snug">
                      This needs the camera and Motion &amp; Orientation access. On iPhone, check
                      Settings › Safari › Motion &amp; Orientation Access.
                    </p>
                    {detail && <p className="text-white/40 text-[10px] mt-2 break-words">{detail}</p>}
                    {onNeedVertical && (
                      <button type="button" onClick={onNeedVertical}
                        className="mt-4 min-h-[48px] px-5 rounded-xl bg-white/15 text-white text-sm font-semibold touch-manipulation">
                        Measure from a photo instead
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {phase === "live" && (
          <div className="shrink min-h-0 px-3 pt-3 space-y-2 bg-ppp-navy overflow-y-auto"
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
            <div className="text-center">
              <span ref={readoutRef}
                className="inline-block px-4 py-1 rounded-full bg-black/60 text-white font-condensed text-3xl font-bold tabular-nums">—</span>
            </div>

            {aimWarning && (
              <p className="text-[11px] text-ppp-orange-100 bg-ppp-orange-50/40 rounded-lg px-3 py-2 leading-snug">
                {aimWarning}
              </p>
            )}

            {calibrating ? (
              <div className="space-y-2">
                <FeetInchesInput
                  label="How long is it really?" value={knownDraft} onChange={setKnownDraft}
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setCalibrating(false); setPoints([]); setLockedM(null); }}
                    className="min-h-[48px] px-4 rounded-xl border border-white/25 text-white text-sm font-semibold touch-manipulation">
                    Cancel
                  </button>
                  <button type="button" onClick={finishCalibration}
                    disabled={lockedM == null || !(toDecimalFeet(knownDraft) > 0)}
                    className="flex-1 min-h-[48px] rounded-xl bg-ppp-green text-ppp-navy text-sm font-bold disabled:opacity-40 touch-manipulation">
                    Use this to set my height
                  </button>
                </div>
              </div>
            ) : lockedM != null && targets.length === 0 ? (
              /* Caller wants the raw number and will ask what it was afterwards.
                 Without this the save row renders with no buttons at all and the
                 measurement cannot be handed back. */
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    const display = formatMetres(lockedM);
                    onResult({ feet: metresToFeet(lockedM), display, confidence: "medium", errorPct: 2 }, "");
                    setPoints([]); setLockedM(null);
                  }}
                  className="w-full min-h-[56px] rounded-xl bg-ppp-green text-ppp-navy text-base font-bold touch-manipulation"
                >
                  Use {formatMetres(lockedM)}
                </button>
                <button type="button" onClick={() => { setPoints([]); setLockedM(null); }}
                  className="w-full min-h-[44px] rounded-xl bg-black/50 text-white text-sm font-semibold touch-manipulation">
                  Measure again
                </button>
              </div>
            ) : lockedM != null ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  {targets.map((t) => (
                    <button key={t.id} type="button"
                      onClick={() => {
                        const display = formatMetres(lockedM);
                        onResult({ feet: metresToFeet(lockedM), display, confidence: "medium", errorPct: 2 }, t.id);
                        setSaved((s) => ({ ...s, [t.label]: display }));
                        setPoints([]); setLockedM(null);
                      }}
                      className={`flex-1 min-h-[52px] rounded-xl text-sm font-bold touch-manipulation ${
                        saved[t.label] ? "bg-ppp-green-100 text-ppp-navy" : "bg-ppp-green text-ppp-navy"
                      }`}
                    >{saved[t.label] ? `${t.label} ✓` : t.label}</button>
                  ))}
                </div>
                <button type="button" onClick={() => { setPoints([]); setLockedM(null); }}
                  className="w-full min-h-[44px] rounded-xl bg-black/50 text-white text-sm font-semibold touch-manipulation">
                  Measure another
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <button type="button" onClick={() => { setPoints([]); setLockedM(null); setAimWarning(null); }}
                  disabled={points.length === 0}
                  className="shrink-0 min-h-[56px] px-4 rounded-xl bg-black/50 text-white text-sm font-semibold disabled:opacity-30 touch-manipulation">
                  ⟲
                </button>
                <button type="button" onClick={addPoint} disabled={capturing}
                  className="flex-1 min-h-[56px] rounded-xl bg-ppp-blue text-ppp-navy text-base font-bold disabled:opacity-60 touch-manipulation">
                  {capturing ? "Hold still…" : points.length === 0 ? "Add first corner" : "Add end corner"}
                </button>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 text-[11px] text-white/60">
              <button type="button" onClick={() => { setCalibrating(true); setPoints([]); setLockedM(null); }}
                className="min-h-[44px] underline touch-manipulation">
                Set my height from a known length
              </button>
              {onNeedVertical && (
                <button type="button" onClick={onNeedVertical} className="min-h-[44px] underline touch-manipulation">
                  Ceiling height →
                </button>
              )}
            </div>
            {Object.keys(saved).length > 0 && (
              <p className="text-center text-white text-[11px] bg-black/40 rounded-full px-3 py-1">
                Saved {Object.entries(saved).map(([k, v]) => `${k} ${v}`).join(" · ")}
              </p>
            )}
          </div>
        )}
      </div>
    </ModalPortal>
  );
}
