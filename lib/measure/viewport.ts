/**
 * Pan-and-zoom maths for the Apple-Measure-style reticle.
 *
 * WHY A RETICLE AT ALL. The first version had you tap the photo directly where
 * you wanted a point. That cannot be made accurate on a phone: a fingertip is
 * roughly 40px across and it lands on top of the very pixel you are aiming at,
 * so you are placing a corner you cannot see. Apple's Measure app never asks
 * for that — it fixes a reticle at the centre of the screen and you move the
 * WORLD under it, then press a large button well away from the target.
 *
 * We do the same with a photo: the reticle is nailed to the centre of the
 * viewport, the image pans and pinches beneath it, and a thumb-sized button at
 * the bottom drops the point. The aiming and the pressing happen in two
 * different places, which is the whole trick.
 *
 * Everything here is pure so the mapping can be tested without a DOM.
 */

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

/** translate-then-scale about the viewport centre. */
export type Transform = { tx: number; ty: number; k: number };

export const IDENTITY: Transform = { tx: 0, ty: 0, k: 1 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

/**
 * How big the image is drawn at k=1: contained inside the viewport, centred,
 * aspect preserved. Matches `object-fit: contain`.
 */
export function fittedSize(natural: Size, viewport: Size): Size {
  if (natural.w <= 0 || natural.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    return { w: 0, h: 0 };
  }
  const scale = Math.min(viewport.w / natural.w, viewport.h / natural.h);
  return { w: natural.w * scale, h: natural.h * scale };
}

/**
 * What the reticle is currently pointing at, in the image's own pixels.
 *
 * The reticle never moves, so this is purely a function of the transform:
 * the offset of the viewport centre from the image centre is exactly
 * (-tx, -ty) in screen pixels, which is (-tx/k, -ty/k) in unscaled image px.
 */
export function reticleToImage(t: Transform, natural: Size, viewport: Size): Point | null {
  const base = fittedSize(natural, viewport);
  if (base.w <= 0 || t.k <= 0) return null;
  const x = (-t.tx / t.k / base.w + 0.5) * natural.w;
  const y = (-t.ty / t.k / base.h + 0.5) * natural.h;
  return { x, y };
}

/** The inverse: where an image pixel currently sits on screen. */
export function imageToViewport(p: Point, t: Transform, natural: Size, viewport: Size): Point | null {
  const base = fittedSize(natural, viewport);
  if (base.w <= 0) return null;
  return {
    x: viewport.w / 2 + t.tx + t.k * ((p.x / natural.w - 0.5) * base.w),
    y: viewport.h / 2 + t.ty + t.k * ((p.y / natural.h - 0.5) * base.h),
  };
}

/**
 * Keep the reticle over the photo.
 *
 * Panning past the edge is not a feature — it strands you on empty background
 * with no way to tell which direction the image went. Clamping means a
 * frustrated swipe always lands somewhere real.
 */
export function clampTransform(t: Transform, natural: Size, viewport: Size): Transform {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k));
  const base = fittedSize(natural, viewport);
  if (base.w <= 0) return { tx: 0, ty: 0, k };
  const maxX = (k * base.w) / 2;
  const maxY = (k * base.h) / 2;
  return {
    k,
    tx: Math.min(maxX, Math.max(-maxX, t.tx)),
    ty: Math.min(maxY, Math.max(-maxY, t.ty)),
  };
}

/**
 * Zoom while holding whatever the reticle is on.
 *
 * Zooming about the viewport centre would slide the target out from under the
 * crosshair, so you would re-aim after every pinch. Scaling the translation by
 * the same factor pins it.
 */
export function zoomAboutReticle(t: Transform, factor: number, natural: Size, viewport: Size): Transform {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * factor));
  const applied = k / t.k;
  return clampTransform({ k, tx: t.tx * applied, ty: t.ty * applied }, natural, viewport);
}

/**
 * Centre the view on a point — used to re-open a placed point for nudging.
 */
export function centreOn(p: Point, k: number, natural: Size, viewport: Size): Transform {
  const base = fittedSize(natural, viewport);
  if (base.w <= 0) return { ...IDENTITY, k };
  return clampTransform(
    {
      k,
      tx: -k * (p.x / natural.w - 0.5) * base.w,
      ty: -k * (p.y / natural.h - 0.5) * base.h,
    },
    natural,
    viewport
  );
}

/** Distance between two active touches, for pinch. */
export function pinchDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
