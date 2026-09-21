/**
 * How often the people one number texts tell it to stop.
 *
 * Karan, 2026-09-21, while choosing a 10DLC brand: "I don't want the brand to
 * suffer because of one number having a high opt out rate."
 *
 * The brand cannot be fully firewalled — a trust score is scored on the
 * company, and T-Mobile's daily limits apply across the whole brand — so the
 * protection that actually works is noticing one bad number quickly. Carriers
 * measure complaints and opt-outs per number; a number that annoys people gets
 * filtered or blocked, and the first anybody normally hears of it is delivery
 * quietly falling off.
 *
 * MEASURED PER PERSON, NOT PER MESSAGE. A conversation is several messages, so
 * a rate per message flatters a number that texts a lot and punishes one that
 * texts carefully. What a carrier cares about, and what PPP should, is the
 * share of PEOPLE who asked it to stop.
 *
 * Pure.
 */

/** Share of people texted who opted out. Above this, somebody should look. */
export const WATCH_RATE = 0.02;
/** Above this, the number is in trouble and the workspace should be paused. */
export const HIGH_RATE = 0.05;
/**
 * Below this many people, a rate is noise: one opt-out out of eight is 12.5%
 * and means nothing. Counted, shown, but never called high.
 */
export const MIN_PEOPLE = 25;

export type WorkspaceOptOuts = {
  workspaceId: string;
  name: string;
  /** Distinct people this number texted in the window. */
  peopleTexted: number;
  /** Of those, how many opted out in the window. */
  optOuts: number;
};

export type OptOutVerdict = "quiet" | "ok" | "watch" | "high";

export type OptOutRate = WorkspaceOptOuts & {
  /** 0-1. Null when nobody was texted at all. */
  rate: number | null;
  verdict: OptOutVerdict;
  /** What to tell somebody reading the row. */
  note: string;
};

export function rateOf(w: WorkspaceOptOuts): number | null {
  if (w.peopleTexted <= 0) return null;
  return w.optOuts / w.peopleTexted;
}

export function verdictFor(w: WorkspaceOptOuts): OptOutVerdict {
  const rate = rateOf(w);
  if (rate === null) return "quiet";
  // Too few people to judge. Said plainly rather than dressed up as a rate.
  if (w.peopleTexted < MIN_PEOPLE) return "quiet";
  if (rate >= HIGH_RATE) return "high";
  if (rate >= WATCH_RATE) return "watch";
  return "ok";
}

export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export function assess(w: WorkspaceOptOuts): OptOutRate {
  const rate = rateOf(w);
  const verdict = verdictFor(w);
  const note =
    verdict === "quiet"
      ? w.peopleTexted === 0
        ? "Nobody texted in this period."
        : `Only ${w.peopleTexted} ${w.peopleTexted === 1 ? "person" : "people"} texted — too few to read anything into.`
      : verdict === "high"
        ? `${formatRate(rate)} of people asked it to stop. Pause this number and read the last few conversations before it gets filtered.`
        : verdict === "watch"
          ? `${formatRate(rate)} is above the ${formatRate(WATCH_RATE)} mark. Worth reading a few of its conversations this week.`
          : `${formatRate(rate)}, which is normal.`;
  return { ...w, rate, verdict, note };
}

/** Worst first: a screen nobody scrolls should open on the number in trouble. */
export function rank(rows: WorkspaceOptOuts[]): OptOutRate[] {
  const order: Record<OptOutVerdict, number> = { high: 0, watch: 1, ok: 2, quiet: 3 };
  return rows
    .map(assess)
    .sort((a, b) => order[a.verdict] - order[b.verdict] || (b.rate ?? -1) - (a.rate ?? -1));
}

/** One line for the top of the page, and for anything that alerts later. */
export function summarise(rows: OptOutRate[]): { needsAttention: number; headline: string } {
  const high = rows.filter((r) => r.verdict === "high");
  const watch = rows.filter((r) => r.verdict === "watch");
  if (high.length) {
    return {
      needsAttention: high.length + watch.length,
      headline: `${high.length} number${high.length === 1 ? "" : "s"} ${high.length === 1 ? "is" : "are"} being asked to stop by more than ${formatRate(HIGH_RATE)} of the people ${high.length === 1 ? "it" : "they"} text: ${high.map((h) => h.name).join(", ")}.`,
    };
  }
  if (watch.length) {
    return {
      needsAttention: watch.length,
      headline: `${watch.length} number${watch.length === 1 ? "" : "s"} above ${formatRate(WATCH_RATE)}: ${watch.map((w) => w.name).join(", ")}.`,
    };
  }
  return { needsAttention: 0, headline: "Every number is inside the normal range." };
}
