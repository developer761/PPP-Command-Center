/**
 * TCPA rules, as pure functions.
 *
 * This is the highest-severity code in the messaging system. Texting someone
 * who opted out, or texting anyone outside their local quiet hours, carries
 * statutory damages per message. There is no "mostly right" here.
 *
 * Everything in this file is pure: keyword classification, quiet-hours maths,
 * and the daily budget predicate. No database, no clock, no I/O — the caller
 * passes `now`. That is deliberate, because the edge cases that matter (a
 * customer replying "Stop." with a full stop, 8:00pm exactly, a DST boundary,
 * a workspace in California while the office is in New York) are all testable
 * only if the inputs are arguments rather than ambient state.
 *
 * The gate in ./gate.ts composes these with the opt-out table and the
 * transport. Nothing here decides to send — these functions only ever answer
 * questions about a message or a moment.
 */

/* ─────────────────────────────  Keywords  ───────────────────────────── */

/**
 * Carrier-mandated opt-out keywords. STOP is the one carriers enforce
 * themselves; the rest are conventional and we honour all of them because a
 * customer who typed CANCEL meant it whether or not a carrier agreed.
 */
const OPT_OUT_KEYWORDS = [
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt out",
] as const;

/** Re-subscribe keywords. Only ever honoured for a number that opted out. */
const OPT_IN_KEYWORDS = ["start", "unstop", "yes"] as const;

/** Help keywords. A reply is legally required. */
const HELP_KEYWORDS = ["help", "info"] as const;

export type InboundIntent = "opt_out" | "opt_in" | "help" | "normal";

/**
 * Normalize an inbound body for keyword matching.
 *
 * Real messages arrive as "Stop.", " STOP ", "stop!", "Stop please" and
 * "STOP\n". Carriers match a bare keyword; we are deliberately slightly more
 * generous on punctuation and surrounding whitespace, because honouring an
 * opt-out we were not strictly required to honour costs us nothing, and
 * missing one costs $500-$1500 per message.
 *
 * We are NOT generous about keywords appearing mid-sentence — "please don't
 * cancel my appointment" must not unsubscribe anyone. Only a message whose
 * entire content is the keyword (plus punctuation) counts.
 */
export function normalizeKeyword(body: string): string {
  return body
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ") // punctuation and symbols → space
    .replace(/\s+/g, " ")
    .trim();
}

/** Classify an inbound message. Only a whole-message keyword counts. */
export function classifyInbound(body: string): InboundIntent {
  const k = normalizeKeyword(body);
  if (!k) return "normal";
  if ((OPT_OUT_KEYWORDS as readonly string[]).includes(k)) return "opt_out";
  if ((OPT_IN_KEYWORDS as readonly string[]).includes(k)) return "opt_in";
  if ((HELP_KEYWORDS as readonly string[]).includes(k)) return "help";
  return "normal";
}

/* ───────────────────────────  Quiet hours  ──────────────────────────── */

/**
 * PPP operates across four time zones (NY, CT, NJ, FL, TX, CO, CA). A send
 * that is legal in Nassau is a violation in San Diego, so the window is always
 * evaluated in the WORKSPACE's timezone, never the server's and never the
 * office's.
 *
 * Federal TCPA is 8am-9pm local. The default here is 9am-8pm — deliberately
 * an hour tighter at each end, because several states are stricter than
 * federal and a contractor texting at 8:05pm reads as rude even where it is
 * legal. A workspace may widen it, but never past the federal bound.
 */
export const DEFAULT_QUIET_HOURS = { startHour: 9, endHour: 20 } as const;
export const FEDERAL_BOUND = { startHour: 8, endHour: 21 } as const;

export type QuietHours = { startHour: number; endHour: number };

/** Clamp a configured window into the federal bound. A misconfigured
 *  workspace must not be able to authorise an illegal send. */
export function clampToFederal(h: QuietHours): QuietHours {
  return {
    startHour: Math.max(h.startHour, FEDERAL_BOUND.startHour),
    endHour: Math.min(h.endHour, FEDERAL_BOUND.endHour),
  };
}

/**
 * The local wall-clock hour in an IANA timezone at a given instant.
 *
 * Uses Intl rather than manual offset arithmetic so DST is handled by the
 * platform's tz database. Offset maths is where this goes wrong: America/New_York
 * is UTC-5 in January and UTC-4 in July, and hand-rolling that means a
 * fortnight a year of sends an hour outside the window.
 */
export function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", hour12: false,
  }).formatToParts(now);
  const h = parts.find((p) => p.type === "hour")?.value;
  // Intl renders midnight as "24" in some ICU versions; normalise to 0.
  return Number(h) % 24;
}

/** Is `now` inside the sending window for this workspace? */
export function withinQuietHours(
  now: Date,
  timeZone: string,
  hours: QuietHours = DEFAULT_QUIET_HOURS
): boolean {
  const { startHour, endHour } = clampToFederal(hours);
  const h = localHour(now, timeZone);
  // Inclusive of the opening hour, exclusive of the closing one: at endHour
  // exactly, the window is shut. 20:00 is not "still 8pm-ish".
  return h >= startHour && h < endHour;
}

/**
 * The next instant a send would be allowed, for scheduling a deferred message
 * rather than dropping it. Returns `now` when already inside the window.
 *
 * Walks forward in whole hours and re-asks in the target timezone rather than
 * computing an offset, so a DST jump cannot produce a time that does not exist.
 */
export function nextSendableTime(
  now: Date,
  timeZone: string,
  hours: QuietHours = DEFAULT_QUIET_HOURS
): Date {
  if (withinQuietHours(now, timeZone, hours)) return now;
  const cursor = new Date(now.getTime());
  cursor.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    cursor.setUTCHours(cursor.getUTCHours() + 1);
    if (withinQuietHours(cursor, timeZone, hours)) return cursor;
  }
  // 48 hours without an open window means the config is broken, not that the
  // world is. Surface it rather than silently returning something plausible.
  throw new Error(`no sendable hour within 48h for ${timeZone} — check quiet-hours config`);
}

/* ────────────────────────────  Daily budget  ────────────────────────── */

/**
 * Five agents can each independently decide to text the same person. Without a
 * shared ceiling, Coordination says "see you tomorrow at 2" the same morning
 * Followup asks "did you get our estimate?".
 *
 * The cap is per CUSTOMER, across every agent and every workspace — a customer
 * who reached PPP through both Meta and Google LSA is still one person with
 * one phone.
 */
export const DEFAULT_DAILY_CAP = 3;

export function withinDailyCap(sentToday: number, cap: number = DEFAULT_DAILY_CAP): boolean {
  return sentToday < cap;
}
