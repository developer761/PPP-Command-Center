/**
 * WHAT SALESFORCE SAYS ABOUT TEXTING THIS PERSON.
 *
 * Twilio rejected the A2P campaign on 2026-10-10, and the second reason was
 * that we could not show proof of opt-in for the Meta lead form. We could not,
 * because consent was nowhere in this system: `SMS_Opt_In__c` was read in
 * exactly two places, the seeded exit rule and `outcomeForExit`, and both of
 * them read it to STOP a conversation. Nothing read it to decide whether to
 * start one, and `consent_basis` was the hardcoded string 'inquiry' on every
 * row ever written.
 *
 * So the checkbox on the estimate form — which has been there the whole time,
 * with correct disclosure text — had no representation anywhere downstream. A
 * lead who ticked it and a lead who was never asked produced identical rows.
 *
 * ── THE SHAPE OF THE BUG THIS FIXES ─────────────────────────────────────
 *
 * Written and never read. The web form collected consent, Salesforce stored
 * it, and the one system that acts on it ignored it. That is the same shape
 * as `first_room` having no writer, inverted: a field with a writer and no
 * reader is just as broken as one with a reader and no writer, and harder to
 * notice, because everything upstream looks like it is working.
 *
 * ── WHY "NONE" IS NOT "NO" ──────────────────────────────────────────────
 *
 * The three states are deliberately not a boolean. Measured 2026-10-10 over
 * 1,584 leads in sf_lead_inbound:
 *
 *     1,576   no value at all        Meta 517, Angi 562, Google 218, ...
 *         8   Opt-In (Verified)
 *         5   Opt-Out
 *
 * A missing value means nobody asked, not that somebody refused. Those two
 * must stay distinguishable: refusing to text an explicit Opt-Out is
 * obligatory, while refusing to text everyone we never asked is a POLICY, and
 * policy belongs to Karan and Katie rather than to this file. Collapsing them
 * into a boolean would quietly make that decision here.
 *
 * Re-measured one day later, 2026-10-11: 1,757 leads, 21 express, 7 opt-out,
 * 1,729 nothing. So Katie's writeback has started to flow — 8 express became
 * 21 — and it is still 98.4% of leads with nothing. Meta is the half that has
 * not moved at all: 579 leads, ZERO express opt-ins, which is the same gap
 * Twilio rejected the campaign over. `npm run check:consent-eligibility`
 * reprints this against live data rather than trusting the number above.
 *
 * Pure. No database, no environment, no clock.
 */
import { readField, type LeadRecord } from "./rules";

export type ConsentState =
  /** An affirmative opt-in is on file. The strongest thing we can show a carrier. */
  | "express"
  /** They asked us to stop. Never text, regardless of any other rule. */
  | "opted_out"
  /** Salesforce holds nothing. Not a refusal — nobody asked. */
  | "none";

export type SmsConsent = {
  state: ConsentState;
  /**
   * The value exactly as Salesforce held it, or null when there was none.
   *
   * Verbatim, not normalised, because this is what gets written to
   * sms_conversations.sms_consent_value and shown to a carrier. A picklist
   * rename should be visible as itself rather than flattened into a bucket.
   */
  value: string | null;
};

/**
 * The values this codebase knows how to act on, lowercased for comparison.
 *
 * Kept in step with `scripts/check-sms-consent-values.mjs`, which reads the
 * live payloads and fails when Salesforce sends something absent from here.
 * That script is what stops this map going stale: a picklist rename is an
 * afternoon's work in Setup, and nothing else in the repo would notice.
 */
const EXPRESS = new Set(["opt-in (verified)", "opt-in (form)"]);
const OPTED_OUT = new Set(["opt-out"]);

/**
 * Anything Salesforce sends that is in neither set.
 *
 * Treated as `none` rather than `express`, so a value nobody has taught this
 * file about can never be read as permission. It is still returned in `value`,
 * so the unrecognised string reaches the database and the check script rather
 * than being swallowed here.
 */
export function readSmsConsent(record: LeadRecord): SmsConsent {
  const raw = readField(record, "SMS_Opt_In__c");
  const value = raw === undefined || raw === null || String(raw).trim() === ""
    ? null
    : String(raw).trim();

  if (value === null) return { state: "none", value: null };

  const key = value.toLowerCase();
  if (OPTED_OUT.has(key)) return { state: "opted_out", value };
  if (EXPRESS.has(key)) return { state: "express", value };
  return { state: "none", value };
}

/**
 * May we open a conversation with this person?
 *
 * `requireExpress` is the policy switch. Off, this refuses only an explicit
 * opt-out — which nobody would argue with, and which the system did not do
 * before. On, it also refuses anyone we have no recorded opt-in for.
 *
 * The caller supplies the flag rather than this file reading an environment
 * variable, so a test states the policy it is testing instead of mutating
 * process.env and hoping nothing else in the run depends on it.
 */
export function mayEnrol(
  consent: SmsConsent,
  opts: { requireExpress: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (consent.state === "opted_out") {
    return {
      ok: false,
      reason: `Salesforce records SMS consent as "${consent.value}" — they have opted out`,
    };
  }
  if (opts.requireExpress && consent.state !== "express") {
    return {
      ok: false,
      reason: consent.value === null
        ? "no SMS consent is recorded on this lead, and SMS_REQUIRE_EXPRESS_CONSENT is on"
        : `SMS consent reads "${consent.value}", which is not a recognised opt-in, `
          + "and SMS_REQUIRE_EXPRESS_CONSENT is on",
    };
  }
  return { ok: true };
}

/**
 * Whether express consent is required to enrol.
 *
 * DEFAULTS TO ON, and the default is the whole point. The two failures are not
 * symmetrical: with it off, flipping sending on enrols every lead we never
 * asked — 1,576 of 1,584 as measured — and texts them. With it on, flipping
 * sending on enrols almost nobody, somebody asks why within the hour, and the
 * refusal reason on every skipped lead says exactly why.
 *
 * A loud nothing is recoverable. A quiet mass-text is not.
 *
 * Set SMS_REQUIRE_EXPRESS_CONSENT=false to relax it, which is a decision for
 * Karan and Katie once the Salesforce writeback is confirmed live and
 * backfilled — not something to switch to get a test passing.
 */
export function requireExpressConsent(
  // Record rather than NodeJS.ProcessEnv: the latter carries index-signature
  // requirements an object literal does not satisfy, so every test would have
  // needed a cast, and a cast in a test is a place a real type error hides.
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SMS_REQUIRE_EXPRESS_CONSENT !== "false";
}
