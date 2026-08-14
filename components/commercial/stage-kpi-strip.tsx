import Link from "next/link";
import type { StageKpi, KpiTone } from "@/lib/commercial/opportunities/stage-kpis";

/**
 * The stage stats — the four or five numbers that matter at THIS point in a
 * job's life, pinned under the title with the parent records as links.
 *
 * Which numbers appear is decided by `stageKpis`, not here: a bid shows when
 * the plans arrived and when the proposal is due, a job on site shows what's
 * billed and the margin. This component only renders whatever it is handed,
 * and renders nothing at all when handed nothing — an empty strip is better
 * than a row of dashes.
 *
 * Karan 2026-08-14: *"more spread, more specific data."* It used to be a single
 * horizontal ticker that scrolled off the right edge — on a phone the third and
 * fourth numbers lived off-screen, and the sub-detail under each got no room.
 * Now it's a responsive GRID of stat cards: every number is on screen at once,
 * each with its own tile so the label / big value / detail line read as one
 * stat instead of three loose fragments, and a tone rail down the left edge
 * makes "is this good or bad" answerable at a glance before reading a digit.
 */

function toneValueCls(tone: KpiTone | undefined): string {
  switch (tone) {
    case "good":
      return "text-emerald-700";
    case "warn":
      return "text-amber-700";
    case "bad":
      return "text-rose-700";
    default:
      return "text-ppp-charcoal";
  }
}

/** The 3px rail down the left of a tile — the at-a-glance health signal. A
 *  neutral tile gets a quiet rail so the card edges still read as separate. */
function toneRailCls(tone: KpiTone | undefined): string {
  switch (tone) {
    case "good":
      return "bg-emerald-400";
    case "warn":
      return "bg-amber-400";
    case "bad":
      return "bg-rose-400";
    default:
      return "bg-ppp-charcoal-200";
  }
}

export function StageKpiStrip({
  kpis,
  identity,
  basePath,
}: {
  kpis: StageKpi[];
  /** Deal URL a KPI's relative href hangs off, so the tile can be clicked
   *  through to the tool that owns the number. */
  basePath: string;
  /** Project number / account — the "what am I looking at" line. */
  identity?: { label: string; value: string; href?: string }[];
}) {
  if (kpis.length === 0 && !identity?.length) return null;
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
      {identity && identity.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-3.5 py-2 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50/60">
          {identity.map((it) => (
            <div key={it.label} className="min-w-0">
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                {it.label}
              </div>
              {it.href ? (
                <Link
                  href={it.href}
                  className="text-[12.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 truncate block min-h-[44px] sm:min-h-[24px] pt-1.5 sm:pt-0"
                >
                  {it.value}
                </Link>
              ) : (
                <div className="text-[12.5px] font-semibold text-ppp-charcoal truncate">{it.value}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {kpis.length > 0 && (
        // ONE row, tiles spread to FILL the width (flex-1) — not a wrapping
        // grid. Karan 2026-08-14: the grid left 4 tiles up top and a 5th alone
        // below with three empty cells of blank space. flex-1 divides the row
        // evenly across however many KPIs there are; on a phone the min-width
        // keeps them legible and the row scrolls rather than crushing.
        <div className="flex items-stretch divide-x divide-ppp-charcoal-100 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {kpis.map((k) => {
            const body = (
              <div className="flex h-full items-stretch gap-2.5 bg-surface group-hover:bg-cc-brand-50/60 transition-colors px-3 py-2.5">
                <span aria-hidden className={`w-[3px] shrink-0 rounded-full ${toneRailCls(k.tone)}`} />
                <div className="min-w-0">
                  <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500 flex items-center gap-1">
                    <span className="truncate">{k.label}</span>
                    {k.href && (
                      <span aria-hidden className="opacity-0 group-hover:opacity-100 transition-opacity text-cc-brand-600">
                        →
                      </span>
                    )}
                  </div>
                  <div
                    className={`font-condensed text-[19px] font-black tabular-nums leading-tight truncate ${toneValueCls(k.tone)}`}
                  >
                    {k.value}
                  </div>
                  {k.sub && (
                    <div className="text-[10.5px] text-ppp-charcoal-500 tabular-nums truncate">
                      {k.sub}
                    </div>
                  )}
                </div>
              </div>
            );
            // A tile with an href becomes a link to the tool that owns the
            // number; one without stays a div. Branched rather than a dynamic
            // component, because `Link` and `div` do not share a prop type and
            // the union silently widens `href` to `string | undefined`.
            return k.href ? (
              <Link key={k.key} href={`${basePath}${k.href}`} className="group flex-1 min-w-[7.5rem] block min-h-[44px]">
                {body}
              </Link>
            ) : (
              <div key={k.key} className="group flex-1 min-w-[7.5rem] min-h-[44px]">
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
