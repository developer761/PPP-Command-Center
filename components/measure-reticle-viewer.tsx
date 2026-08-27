"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  clampTransform, fittedSize, imageToViewport, reticleToImage, zoomAboutReticle,
  IDENTITY, MIN_ZOOM, MAX_ZOOM,
  type Point, type Size, type Transform,
} from "@/lib/measure/viewport";
import {
  initialGesture, pointerDown, pointerMove, pointerUp, type GestureState,
} from "@/lib/measure/gesture";

/**
 * A photo you aim at, rather than one you poke.
 *
 * The crosshair is fixed dead centre and the image moves underneath it —
 * Apple's Measure app model. It exists because tapping the photo directly can
 * never be precise on a phone: the fingertip lands on the pixel you are trying
 * to see. Here the aiming (drag anywhere) and the committing (a button at the
 * bottom) happen in different places, so nothing is ever hidden under a thumb,
 * and pinching to 8× makes a window frame corner a genuinely exact target.
 */
export default function MeasureReticleViewer({
  imageUrl, alt, points, lines, onReticleChange, hint,
}: {
  imageUrl: string;
  alt: string;
  /** Already-placed points, in the image's own pixels. */
  points: Array<{ p: Point; tone: "ref" | "target"; n: number }>;
  lines: Array<{ a: Point; b: Point; tone: "ref" | "target" }>;
  /** Fires whenever the crosshair moves, in image pixels. */
  onReticleChange: (p: Point | null) => void;
  hint?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [t, setT] = useState<Transform>(IDENTITY);

  // Live pointer bookkeeping. A ref, not state: it changes on every frame of a
  // drag and re-rendering per move would drop frames on an older phone. The
  // transitions themselves live in a pure reducer (lib/measure/gesture) so a
  // throwing DOM side effect can never skip a state write again.
  const gesture = useRef<GestureState>(initialGesture());

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // Measure once up front rather than waiting for the observer's first
    // callback. If the photo's intrinsic size arrives while the viewport is
    // still 0×0, the probe image below unmounts and the visible one has no
    // size to render into — the tool goes blank with no error and no way back.
    const r0 = el.getBoundingClientRect();
    if (r0.width > 0) setViewport({ w: r0.width, h: r0.height });
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      if (r.width > 0) setViewport({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Report the aim upward. Recomputed from the transform, so it stays true
  // through rotation and keyboard-driven viewport changes too.
  useEffect(() => {
    if (!natural || viewport.w <= 0) { onReticleChange(null); return; }
    onReticleChange(reticleToImage(t, natural, viewport));
  }, [t, natural, viewport, onReticleChange]);

  const apply = useCallback((next: Transform) => {
    if (!natural || viewport.w <= 0) return;
    setT(clampTransform(next, natural, viewport));
  }, [natural, viewport]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Record the pointer BEFORE capturing it. setPointerCapture throws
    // NotFoundError for a pointer the browser no longer considers active, and
    // with the calls the other way round that exception skipped the bookkeeping
    // entirely — pointermove then found no start position and the photo simply
    // would not pan, with nothing logged and nothing to see.
    gesture.current = pointerDown(gesture.current, e.pointerId, { x: e.clientX, y: e.clientY });
    // Capture on the container, not e.target: the target may be the <img>,
    // which re-renders on every frame of the drag and takes the capture with it.
    try {
      boxRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is an optimisation — the drag still tracks without it.
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { state, effect } = pointerMove(gesture.current, e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = state;
    if (effect.kind === "pan") {
      apply({ ...t, tx: t.tx + effect.dx, ty: t.ty + effect.dy });
    } else if (effect.kind === "zoom" && natural) {
      apply(zoomAboutReticle(t, effect.factor, natural, viewport));
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    gesture.current = pointerUp(gesture.current, e.pointerId);
    try {
      boxRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released, or never captured. Either way there is nothing to do.
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!natural) return;
    apply(zoomAboutReticle(t, e.deltaY < 0 ? 1.12 : 1 / 1.12, natural, viewport));
  };

  // Arrow keys nudge — a mouse is coarse too, and this is the accessible path
  // to placing a point without a pointing device at all.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 20 : 2;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const m = moves[e.key];
    if (m) { e.preventDefault(); apply({ ...t, tx: t.tx + m[0], ty: t.ty + m[1] }); return; }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); natural && apply(zoomAboutReticle(t, 1.3, natural, viewport)); }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); natural && apply(zoomAboutReticle(t, 1 / 1.3, natural, viewport)); }
  };

  const base = natural ? fittedSize(natural, viewport) : { w: 0, h: 0 };
  const project = (p: Point) => (natural ? imageToViewport(p, t, natural, viewport) : null);
  const TONE = { ref: "#8DC442", target: "#2BAAE1" } as const;

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden bg-black">
      <div
        ref={boxRef}
        role="application"
        tabIndex={0}
        aria-label={`${alt}. Drag to aim the crosshair, pinch or use plus and minus to zoom, arrow keys to nudge.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        // touch-none stops Safari from taking the drag as a page scroll and
        // the pinch as a browser zoom — without it neither gesture reaches us.
        className="absolute inset-0 touch-none select-none cursor-grab active:cursor-grabbing focus:outline-none"
      >
        {natural && base.w > 0 && (
          <div
            className="absolute left-1/2 top-1/2 will-change-transform"
            style={{
              width: base.w, height: base.h,
              transform: `translate(-50%,-50%) translate(${t.tx}px, ${t.ty}px) scale(${t.k})`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="" draggable={false} className="w-full h-full" />
          </div>
        )}
        {/* Measured off-screen purely to learn the intrinsic size. Stays
            mounted until the visible layer can genuinely draw — unmounting it
            the moment `natural` lands would strand the viewer blank whenever
            the viewport hadn't been measured yet. */}
        {!(natural && base.w > 0) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl} alt={alt} className="opacity-0 absolute w-px h-px"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        )}

        {/* Placed points and the lines between them, drawn in screen space so
            they track the pan exactly. */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
          {lines.map((l, i) => {
            const a = project(l.a), b = project(l.b);
            if (!a || !b) return null;
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={TONE[l.tone]} strokeWidth={3} strokeLinecap="round" />;
          })}
          {points.map((pt, i) => {
            const s = project(pt.p);
            if (!s) return null;
            return (
              <g key={i}>
                <circle cx={s.x} cy={s.y} r={7} fill={TONE[pt.tone]} stroke="#fff" strokeWidth={2} />
                <text x={s.x} y={s.y - 12} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff"
                  stroke="rgba(0,0,0,.55)" strokeWidth={2.5} paintOrder="stroke">{pt.n}</text>
              </g>
            );
          })}
        </svg>

        {/* The crosshair. Never moves, never covered. */}
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
            <circle cx="36" cy="36" r="2.5" fill="#EE662E" stroke="#fff" strokeWidth="1" />
          </svg>
        </div>
      </div>

      {hint && (
        <p className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/60 text-white text-[11px] font-medium pointer-events-none max-w-[92%] text-center">
          {hint}
        </p>
      )}

      {/* Zoom is on-screen as well as pinch: a rep on a desktop, or anyone
          one-handed on a ladder, has no second finger to spare. */}
      <div className="absolute right-2 bottom-2 flex flex-col gap-1.5">
        {([["+", 1.4] as const, ["−", 1 / 1.4] as const]).map(([sym, f]) => (
          <button
            key={sym} type="button"
            onClick={() => natural && apply(zoomAboutReticle(t, f, natural, viewport))}
            aria-label={f > 1 ? "Zoom in" : "Zoom out"}
            disabled={!natural || (f > 1 ? t.k >= MAX_ZOOM : t.k <= MIN_ZOOM)}
            className="h-11 w-11 rounded-full bg-black/55 text-white text-xl leading-none font-semibold backdrop-blur-sm disabled:opacity-30 touch-manipulation"
          >{sym}</button>
        ))}
        <span className="text-center text-[10px] text-white/80 tabular-nums">{t.k.toFixed(1)}×</span>
      </div>
    </div>
  );
}
