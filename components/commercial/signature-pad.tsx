"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

/**
 * Draw-your-signature pad for the Operating Company (Karan 2026-07-31: Brendan
 * draws his signature once, we reuse it everywhere; he can redraw/erase). The
 * drawn strokes export to a transparent PNG and upload through the same
 * signature slot (/api/commercial/operating-company/asset, kind=signature), so
 * everything downstream (tap-to-sign, warranty) just works.
 */
export function SignaturePad({ hasSignature }: { hasSignature: boolean }) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(true);

  // Size the canvas to its CSS box × devicePixelRatio for crisp strokes.
  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#172B4D";
  }, []);

  useEffect(() => {
    setup();
    // Re-size the backing store on viewport/orientation change so pointer
    // coordinates stay aligned (setting canvas width clears it, so reset the
    // empty state — a rare mid-draw resize starts fresh rather than misaligned).
    const onResize = () => {
      setup();
      setEmpty(true);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [setup]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (empty) setEmpty(false);
  };
  const end = () => {
    drawing.current = false;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
    setError(null);
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas || empty) {
      setError("Draw your signature first.");
      return;
    }
    setBusy(true);
    setError(null);
    canvas.toBlob(async (blob) => {
      if (!blob) {
        setError("Couldn't capture the signature — try again.");
        setBusy(false);
        return;
      }
      try {
        const fd = new FormData();
        fd.append("kind", "signature");
        fd.append("file", new File([blob], "signature.png", { type: "image/png" }));
        const res = await fetch("/api/commercial/operating-company/asset", { method: "POST", body: fd });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(json.error ?? "Save failed.");
          return;
        }
        clear();
        router.refresh();
      } catch {
        setError("Network error — try again.");
      } finally {
        setBusy(false);
      }
    }, "image/png");
  };

  return (
    <div>
      <p className="text-[11px] text-ppp-charcoal-500 mb-2">
        {hasSignature ? "A signature is on file. Draw a new one below to replace it." : "Draw the signature once — it's reused on every document that needs signing."}
      </p>
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="w-full h-36 rounded-lg border border-dashed border-ppp-charcoal-300 bg-ppp-charcoal-50/40 touch-none cursor-crosshair"
        aria-label="Signature drawing area"
      />
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <button type="button" onClick={save} disabled={busy || empty} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation">
          {busy ? "Saving…" : hasSignature ? "Replace signature" : "Use this signature"}
        </button>
        <button type="button" onClick={clear} disabled={busy || empty} className="text-[12px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal disabled:opacity-40 min-h-[44px] px-2">
          Clear
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-700 mt-2">{error}</p>}
    </div>
  );
}
