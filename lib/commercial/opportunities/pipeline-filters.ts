/**
 * The pipeline's chip filters — stale, hot, new, overdue, cold RFP, follow-up.
 *
 * ONE implementation, called by the board (`app/commercial/opportunities/
 * page.tsx`) and by its CSV export. They used to be two copies, and the export's
 * copy parsed DATE columns with `new Date("2026-10-16")` — UTC midnight, which
 * is 8pm the evening BEFORE in New York — and compared them to `Date.now()`. So
 * "Export" on a filtered board handed back a different set than the board:
 * a proposal due today was overdue in the CSV and not on screen, the hot window
 * ran a day short, and cold RFPs tipped over a day early.
 *
 * Every date here is an Eastern calendar day. `todayEt` is passed in so the
 * caller owns the clock: the board and the file it exports can't disagree
 * about what day it is, and a test can say which day it is.
 *
 * Plain module (no server-only) — pure functions over plain rows.
 */
import { etDateOf } from "@/lib/date-et";
import {
  OPEN_OPP_STATUSES,
  STALE_OPP_DAYS,
  HOT_DEAL_BID_CENTS,
  HOT_DEAL_DECISION_DAYS,
  HOT_DEAL_ACTIVE_STATUSES,
  isOverdueProposal,
  isColdRfp,
  isFollowUpDue,
} from "@/lib/commercial/opportunities/constants";

export type PipelineFilterOpp = {
  status: string;
  updated_at?: string | null;
  created_at?: string | null;
  bid_value_high_cents?: number | null;
  proposal_due_at?: string | null;
  rfp_received_at?: string | null;
  follow_up_at?: string | null;
};

export type PipelineChipFilters = {
  stale?: boolean;
  hot?: boolean;
  /** "New in the last N days" — N, or undefined for off. */
  newDays?: number;
  overdue?: boolean;
  coldRfp?: boolean;
  followup?: boolean;
};

/** Whole calendar days from `fromYmd` to `toYmd` (to − from). NaN on junk. */
function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${toYmd.slice(0, 10)}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Open, and nobody has touched it in STALE_OPP_DAYS Eastern days. */
export function isStaleOpp(o: PipelineFilterOpp, todayEt: string): boolean {
  if (!(OPEN_OPP_STATUSES as readonly string[]).includes(o.status)) return false;
  const d = etDateOf(o.updated_at);
  if (!d) return false;
  const days = calendarDaysBetween(d, todayEt);
  return Number.isFinite(days) && days >= STALE_OPP_DAYS;
}

/** Big bid, still in play, proposal due today or within HOT_DEAL_DECISION_DAYS. */
export function isHotDeal(o: PipelineFilterOpp, todayEt: string): boolean {
  if (!(HOT_DEAL_ACTIVE_STATUSES as readonly string[]).includes(o.status)) return false;
  if (!o.bid_value_high_cents || o.bid_value_high_cents < HOT_DEAL_BID_CENTS) return false;
  const due = etDateOf(o.proposal_due_at);
  if (!due) return false;
  const daysUntilDue = calendarDaysBetween(todayEt, due);
  return Number.isFinite(daysUntilDue) && daysUntilDue >= 0 && daysUntilDue <= HOT_DEAL_DECISION_DAYS;
}

/** The first Eastern day inside "new in the last N days". */
export function newSinceCutoff(todayEt: string, days: number): string {
  const t = Date.parse(`${todayEt.slice(0, 10)}T12:00:00Z`) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Created on or after the cutoff — by the EASTERN day it was created.
 * `created_at` is a timestamptz; slicing it took the UTC day, so a deal
 * entered at 9pm counted as the next day's.
 */
export function isCreatedSince(o: PipelineFilterOpp, cutoffYmd: string): boolean {
  const d = etDateOf(o.created_at);
  return !!d && d >= cutoffYmd;
}

/** Apply every chip that is on. Order doesn't matter — each is a pure filter. */
export function applyPipelineChipFilters<T extends PipelineFilterOpp>(
  opps: T[],
  f: PipelineChipFilters,
  todayEt: string,
): T[] {
  let out = opps;
  if (f.stale) out = out.filter((o) => isStaleOpp(o, todayEt));
  if (f.hot) out = out.filter((o) => isHotDeal(o, todayEt));
  if (f.newDays) {
    const cutoff = newSinceCutoff(todayEt, f.newDays);
    out = out.filter((o) => isCreatedSince(o, cutoff));
  }
  if (f.overdue) out = out.filter((o) => isOverdueProposal(o, todayEt));
  if (f.coldRfp) out = out.filter((o) => isColdRfp(o, todayEt));
  if (f.followup) out = out.filter((o) => isFollowUpDue(o, todayEt));
  return out;
}
