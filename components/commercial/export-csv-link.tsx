/**
 * The Export CSV control for a report.
 *
 * Was hand-inlined per report, which is how three of them ended up without one
 * at all. One component means adding a report export is a one-liner, and every
 * report's button looks and behaves the same.
 *
 * `preset` is threaded onto the URL so the file covers the window currently on
 * screen — a download that silently exports a different range than the page it
 * came from is worse than no download, because the discrepancy is invisible.
 */
export function ExportCsvLink({
  href,
  preset,
  params,
  label = "Export CSV",
  disabled = false,
  disabledHint,
}: {
  /** The export route, without query string. */
  href: string;
  /** Current preset key, forwarded so the export matches the screen. */
  preset?: string;
  /** Any additional query params to forward (e.g. win/loss custom from+to). */
  params?: Record<string, string | undefined>;
  label?: string;
  /** Nothing to export — rendered as inert text rather than removed, so the
   *  control doesn't vanish and leave people wondering where export went. */
  disabled?: boolean;
  disabledHint?: string;
}) {
  const qs = new URLSearchParams();
  if (preset) qs.set("preset", preset);
  for (const [k, v] of Object.entries(params ?? {})) if (v) qs.set(k, v);
  const url = qs.toString() ? `${href}?${qs.toString()}` : href;

  const icon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" />
    </svg>
  );

  if (disabled) {
    return (
      <span
        title={disabledHint ?? "Nothing to export yet"}
        aria-disabled="true"
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50 text-ppp-charcoal-400 text-[13px] font-semibold min-h-[44px] cursor-not-allowed"
      >
        {icon}
        {label}
      </span>
    );
  }

  return (
    <a
      href={url}
      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 hover:border-cc-brand-300 hover:text-cc-brand-700 transition-colors min-h-[44px]"
    >
      {icon}
      {label}
    </a>
  );
}
