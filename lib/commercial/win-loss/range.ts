import {
  currentQuarterRange,
  previousQuarterRange,
  currentYearRange,
  previousYearRange,
  etMidnightToUTC,
} from "@/lib/commercial/win-loss/reports";

/**
 * Win/Loss date-range parsing — shared by the report page and its export route.
 *
 * Extracted rather than copied. The subtlety that makes a second copy dangerous
 * is the INCLUSIVE end date: `to` is pushed forward one day because the DB
 * filter is `.lt()`, so a naive reimplementation silently drops every debrief
 * stamped on the last day of the window. There is also an ET-midnight rule
 * (an earlier attempt used T12:00:00Z = 8am ET and cut both ends of the range).
 * Both are easy to get subtly wrong twice in different ways, which is exactly
 * what an export that disagrees with the screen looks like.
 */

/** Local to this module: takes a Date, unlike the cents-formatter's version
 *  which takes an ISO string. Kept identical to what the page rendered. */
function fmtEtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export type WinLossPreset = "this_quarter" | "last_quarter" | "this_year" | "last_year";

export const WIN_LOSS_PRESETS: ReadonlyArray<{ key: WinLossPreset; label: string }> = [
  { key: "this_quarter", label: "This Quarter" },
  { key: "last_quarter", label: "Last Quarter" },
  { key: "this_year", label: "This Year" },
  { key: "last_year", label: "Last Year" },
];

type Preset = WinLossPreset;

function parseYmdParts(ymd: string): { year: number; monthIdx: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const monthIdx = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  if (year < 1970 || year > 2100 || monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
  return { year, monthIdx, day };
}

export function parseRange(sp: { from?: string; to?: string; preset?: string }): {
  fromIso: string;
  toIso: string;
  label: string;
  /** What kind of range the user is viewing — drives chip highlight state. */
  activeKey: Preset | "custom";
  /** Echoed back into the custom-range form's date inputs so the picker
   *  remembers what was last submitted (or shows today as a sane default). */
  fromYmd: string;
  toYmd: string;
  /** True iff the user supplied from/to but we couldn't accept it. The page
   *  renders an inline hint so the fallback isn't invisible. */
  rejected: boolean;
} {
  // Custom range always wins if both dates are present + valid.
  if (sp.from && sp.to) {
    // Parse bare YYYY-MM-DD → { year, monthIdx, day } for etMidnightToUTC.
    // Round 3 recheck audit 2026-07-01: an earlier attempt used
    // `new Date(ymd + "T12:00:00Z")` which is 8am ET, silently excluding
    // debriefs stamped between midnight and 8am ET on `sp.from` AND
    // debriefs from 8am ET onward on `sp.to`. The presets (currentQuarter,
    // etc.) already use etMidnightToUTC — the custom range must too.
    const fromParts = parseYmdParts(sp.from);
    const toParts = parseYmdParts(sp.to);
    if (fromParts && toParts) {
      const fromIso = etMidnightToUTC(fromParts.year, fromParts.monthIdx, fromParts.day).toISOString();
      // Push toIso forward one day so the last day is INCLUSIVE (matches
      // the .lt() DB filter — without this, picking "to=Jun 30" silently
      // drops every Jun 30 debrief).
      const toMidnight = etMidnightToUTC(toParts.year, toParts.monthIdx, toParts.day + 1);
      const toIso = toMidnight.toISOString();
      if (new Date(fromIso).getTime() <= new Date(toIso).getTime()) {
        return {
          fromIso,
          toIso,
          label: `${fmtEtDate(new Date(fromIso))} – ${fmtEtDate(new Date(toMidnight.getTime() - 86_400_000))}`,
          activeKey: "custom",
          fromYmd: sp.from,
          toYmd: sp.to,
          rejected: false,
        };
      }
    }
  }
  const supplied = !!(sp.from || sp.to);
  // Otherwise pick a preset (default: this quarter).
  const preset = (sp.preset as Preset) ?? "this_quarter";
  let r: ReturnType<typeof currentQuarterRange>;
  let key: Preset;
  switch (preset) {
    case "last_quarter": r = previousQuarterRange(); key = "last_quarter"; break;
    case "this_year": r = currentYearRange(); key = "this_year"; break;
    case "last_year": r = previousYearRange(); key = "last_year"; break;
    case "this_quarter":
    default: r = currentQuarterRange(); key = "this_quarter"; break;
  }
  // For the custom-form defaults, pre-fill with the active preset's bounds.
  return {
    fromIso: r.fromIso,
    toIso: r.toIso,
    label: r.label,
    activeKey: key,
    fromYmd: r.fromIso.slice(0, 10),
    toYmd: new Date(new Date(r.toIso).getTime() - 86_400_000).toISOString().slice(0, 10),
    rejected: supplied,
  };
}
