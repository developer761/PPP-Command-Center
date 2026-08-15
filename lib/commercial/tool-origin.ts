/**
 * Which deal tab a delivery tool was opened FROM.
 *
 * The deal page's delivery strip (overview/docs/activity) stamps `?from=<tab>`
 * on each tool link so the tool's back arrow returns to that tab instead of the
 * Project tool list. For the back arrow to survive a save, the tool's own
 * redirects have to carry `from` forward — this is the one place that validates
 * and re-serialises it, mirroring how `back` (the post-job-list origin) is
 * already threaded through the same redirects.
 *
 * Only the three group tabs that actually render the strip are legal origins;
 * anything else (or absent — e.g. a link from the Project home cards) yields ""
 * so the back arrow falls back to the tool list.
 */
export type ToolOrigin = "overview" | "docs" | "activity";

export function normalizeToolOrigin(
  raw: string | null | undefined
): ToolOrigin | null {
  return raw === "overview" || raw === "docs" || raw === "activity" ? raw : null;
}

/** `&from=overview` when the origin is a real strip tab, else "". Always safe to
 *  concatenate onto a URL that already has a `?` (every tool redirect does). */
export function toolOriginQs(raw: string | null | undefined): string {
  const o = normalizeToolOrigin(raw);
  return o ? `&from=${o}` : "";
}
