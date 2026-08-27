"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ModalPortal from "@/components/modal-portal";

/**
 * A live viewfinder, not a camera roll.
 *
 * The old flow used `<input type="file" capture="environment">`, which hands
 * off to the phone's Camera app, makes you press a shutter, and gives back a
 * photo. Karan's objection is exactly right: Apple's Measure never does that.
 * You point the phone, press a button, press it again, and read the number.
 *
 * WHAT WE CAN AND CANNOT COPY. Apple gets scale from LiDAR and ARKit motion
 * tracking. Safari exposes neither — there is no WebXR on iOS and no depth API
 * — so scale has to come from something of known size in the frame. What we CAN
 * copy is the feel: the camera lives inside the app, nothing is saved to the
 * camera roll, and there is no shutter.
 *
 * The one unavoidable difference is this: both ends of a measurement must be
 * seen from the SAME camera position, or the pixel geometry means nothing.
 * ARKit solves that by tracking the phone through space. We solve it by holding
 * the frame still once you have it framed — one button press, after which you
 * can lower the phone and take your time placing points precisely. That is
 * strictly easier than holding a phone steady at arm's length, it just has to
 * be explained rather than felt.
 */
export default function MeasureLiveCamera({
  label, onFrame, onClose,
}: {
  label: string;
  /** Hands back a frozen frame as a data URL — never written to the gallery. */
  onFrame: (dataUrl: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"starting" | "live" | "denied" | "unavailable">("starting");
  const [detail, setDetail] = useState<string | null>(null);
  /**
   * getUserMedia can sit unresolved indefinitely — the permission sheet is
   * waiting on the user, or the device is enumerating, or nothing is ever going
   * to happen. Without this the screen is black, the button is disabled, and
   * the only way out is the ✕. Deliberately does NOT cancel the request: the
   * prompt may still be on screen and answering it should still work. It only
   * offers a way round.
   */
  const [slow, setSlow] = useState(false);

  /** Always release the camera. A stream left running keeps the phone's
   *  privacy light on and holds the device against other apps. */
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setState("unavailable");
        setDetail("This browser can't open the camera in-page.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // The rear camera, at the highest sensible resolution — every extra
          // pixel is precision when placing a corner.
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // iOS refuses to autoplay without an explicit play() after srcObject.
          await videoRef.current.play().catch(() => {});
        }
        setState("live");
      } catch (err) {
        if (cancelled) return;
        const name = err instanceof Error ? err.name : "";
        setState(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable");
        setDetail(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; stopStream(); };
  }, [stopStream]);

  useEffect(() => {
    if (state !== "starting") { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Grab the current frame at full sensor resolution and hand it upward. */
  const freeze = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    stopStream();
    // JPEG at 0.92: the measurement reads edges, and compression artefacts on a
    // door frame are precision thrown away for a smaller string nobody stores.
    onFrame(c.toDataURL("image/jpeg", 0.92));
  };

  return (
    <ModalPortal>
      <div className="fixed inset-x-0 top-0 z-50 h-dvh-full bg-black flex flex-col">
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 bg-ppp-navy">
          <div className="min-w-0">
            <div className="text-white font-semibold text-sm truncate">{label}</div>
            <div className="text-white/70 text-[11px]">
              {state === "live"
                ? "Frame the wall, then hold it steady"
                : state === "starting"
                  ? (slow ? "Still waiting for the camera" : "Opening the camera…")
                  : "Camera unavailable"}
            </div>
          </div>
          <button
            type="button" onClick={() => { stopStream(); onClose(); }} aria-label="Close"
            className="shrink-0 h-11 w-11 rounded-lg text-white/80 hover:bg-white/10 text-xl touch-manipulation"
          >✕</button>
        </div>

        <div className="relative flex-1 min-h-0 bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={`absolute inset-0 w-full h-full object-contain ${state === "live" ? "" : "opacity-0"}`}
          />

          {state === "live" && (
            <>
              {/* The same crosshair the measuring screen uses, so the framing
                  you choose here is visibly the framing you'll aim within. */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden>
                  <circle cx="36" cy="36" r="20" fill="none" stroke="rgba(0,0,0,.45)" strokeWidth="4" />
                  <circle cx="36" cy="36" r="20" fill="none" stroke="#fff" strokeWidth="1.75" />
                  {[[36,2,36,18],[36,54,36,70],[2,36,18,36],[54,36,70,36]].map(([x1,y1,x2,y2], i) => (
                    <g key={i}>
                      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,.45)" strokeWidth="4" strokeLinecap="round" />
                      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#fff" strokeWidth="1.75" strokeLinecap="round" />
                    </g>
                  ))}
                </svg>
              </div>
              <p className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/60 text-white text-[11px] font-medium max-w-[92%] text-center pointer-events-none">
                Get a door, window or outlet in shot — that's what gives the scale
              </p>
            </>
          )}

          {state === "starting" && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="max-w-sm text-center">
                <div
                  className="mx-auto h-7 w-7 rounded-full border-2 border-white/25 border-t-white animate-spin"
                  role="status" aria-label="Opening the camera"
                />
                <p className="text-white/70 text-[12px] mt-4 leading-snug">
                  {slow
                    ? "If your phone asked for camera permission, answer that prompt. If nothing appeared, the camera may be in use by another app."
                    : "Allow camera access if your phone asks."}
                </p>
                {slow && (
                  <button
                    type="button" onClick={() => fileRef.current?.click()}
                    className="mt-4 min-h-[48px] px-5 rounded-xl bg-white/15 text-white text-sm font-semibold touch-manipulation"
                  >
                    Choose a photo instead
                  </button>
                )}
              </div>
            </div>
          )}

          {(state === "denied" || state === "unavailable") && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="max-w-sm text-center">
                <p className="text-white font-semibold text-sm">
                  {state === "denied" ? "Camera permission was declined" : "Can't open the camera here"}
                </p>
                <p className="text-white/70 text-[12px] mt-2 leading-snug">
                  {state === "denied"
                    ? "Allow camera access for this site in your browser settings, then reopen this. You can also pick an existing photo instead."
                    : "This usually means the page isn't on a secure connection, or the device has no camera. You can pick an existing photo instead."}
                </p>
                {detail && <p className="text-white/40 text-[10px] mt-2 break-words">{detail}</p>}
                <button
                  type="button" onClick={() => fileRef.current?.click()}
                  className="mt-4 min-h-[48px] px-5 rounded-xl bg-white/15 text-white text-sm font-semibold touch-manipulation"
                >
                  Choose a photo instead
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          className="shrink-0 px-4 pt-3 bg-ppp-navy"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button" onClick={freeze} disabled={state !== "live"}
            className="w-full min-h-[56px] rounded-xl bg-ppp-blue text-ppp-navy text-base font-bold disabled:opacity-40 active:bg-ppp-blue-400 transition-colors touch-manipulation"
          >
            Hold this view
          </button>
          <p className="text-white/55 text-[11px] text-center mt-2 leading-snug">
            The picture stays in this page — nothing is saved to your photos.
          </p>
        </div>

        {/* Only reachable from the fallback above. */}
        <input
          ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => { stopStream(); onFrame(String(reader.result)); };
            reader.readAsDataURL(file);
          }}
        />
      </div>
    </ModalPortal>
  );
}
