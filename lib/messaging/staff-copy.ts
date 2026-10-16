/**
 * Internal keys, said in words staff use.
 *
 * Production walkthrough 2026-10-16: staff screens showed
 * "SMS_REQUIRE_EXPRESS_CONSENT is on", "not_serviced: …", "It is trying to
 * ask_project_details" and a bot's workflow key ("lead_nurture") in the place
 * a person's name goes. Every one of those is a value the code stores and
 * should keep storing; this is only how it is read out.
 *
 * Pure.
 */

/* ─────────────────────────────── who ─────────────────────────────── */

/**
 * A bot agent's key rather than a person.
 *
 * owning_agent and sent_by_agent hold a person's name when somebody takes a
 * conversation over or replies (their profile name or email), and a workflow
 * key like "lead_nurture" or "followup" when the bot holds it. A person's
 * stored name has a capital, a space or an "@"; a key is lowercase snake case.
 */
export function isBotAgentKey(name: string | null | undefined): boolean {
  return !!name && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name.trim());
}

const BOT_PERSONA = "Emily";

/** The bot, where a person's name would otherwise go. */
export const BOT_LABEL = `${BOT_PERSONA} (bot)`;

const BOT_WORKFLOW: Record<string, string> = {
  lead_nurture: "new leads",
  followup: "follow-ups",
};

/**
 * Who is holding or sent something, for a screen.
 *
 * `workflow: true` adds which of the bot's jobs it is, for the AI agents
 * table where that is the whole point of the row.
 */
export function agentLabel(name: string | null | undefined, opts: { workflow?: boolean } = {}): string | null {
  if (!name?.trim()) return null;
  if (!isBotAgentKey(name)) return name.trim();
  if (!opts.workflow) return BOT_LABEL;
  const key = name.trim();
  const job = BOT_WORKFLOW[key] ?? key.replace(/_/g, " ");
  return `${BOT_PERSONA}, ${job}`;
}

/* ─────────────────────────────── numbers ─────────────────────────────── */

/**
 * A customer's number for a screen. formatUs hands back whatever it cannot
 * format, so a stored "+15550152" (seven digits after the +1) showed as
 * though it were a number; it now says it is not one.
 */
export function phoneForDisplay(raw: string | null | undefined): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(raw ?? "");
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  if (!raw?.trim()) return "No number";
  return `${raw.trim()} (not a valid number)`;
}

/* ─────────────────────────── what it is doing ─────────────────────────── */

const INTENT: Record<string, string> = {
  ask_project_details: "ask about the project",
  ask_address: "ask for the address",
  ask_contact: "ask for contact details",
  ask_availability: "ask when they are free",
  acknowledge: "acknowledge what they said",
  answer_question: "answer their question",
  present_offsite_quote: "set up a quick quote without a visit",
  offer_offsite_quote: "offer a quick quote without a visit",
  escalate: "hand the conversation to a person",
  bot_suspected: "answer whether it is a bot",
  defer_to_estimator: "leave the question for the estimator",
  checking_availability: "check whether PPP covers the area",
  acknowledge_negative: "acknowledge something that landed badly",
  confirm_scope: "confirm the project",
  confirm_address: "confirm the address",
  confirm_contact: "confirm contact details",
  success: "close it as booked",
  discard: "close it as discarded",
  schedule_follow_up: "schedule a follow-up",
  lost: "close it as lost",
  bailout: "end the conversation",
  phone_pricing: "move pricing to a phone call",
  transferred: "transfer it",
  msg_liked_loved: "take the reaction as a yes",
  area_not_serviced: "say the area is not covered",
};

/** "ask_project_details" → "ask about the project". Unknown keys lose their underscores. */
export function intentPhrase(intent: string): string {
  return INTENT[intent] ?? intent.replace(/_/g, " ");
}

/* ─────────────────────────── why a lead is held ─────────────────────────── */

const REASON_LEAD: Record<string, string> = {
  no_contactable_phone: "No phone we can text",
  no_matching_workspace: "No workspace matches where this lead came from",
  region_not_live: "",
  workspace_has_no_number: "Its workspace has no number to text from",
  not_serviced: "Outside the area PPP serves",
  region_unclear: "Not clear which team covers it",
};

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** One stored triage or ignore reason, as a sentence. */
export function plainLeadReason(reason: string): string {
  let r = reason.trim();
  // The SMS consent policy, by what it does rather than the variable's name.
  r = r.replace(/,?\s*and SMS_REQUIRE_EXPRESS_CONSENT is on/i, ", and PPP only texts leads who agreed to texts");

  const m = /^([a-z_]+):\s*([\s\S]*)$/.exec(r);
  if (!m || !(m[1] in REASON_LEAD)) return cap(r);
  const [, code, rawDetail] = m;
  let detail = rawDetail
    // Older rows quoted the number itself. Never on a screen.
    .replace(/"[^"]*"\s*is not a number we can text/, "the number on the record cannot be texted")
    // "source=Meta state=— locality=—"
    .replace(/^source=(.*?)\s+state=(\S+)\s+locality=(\S+)$/, (_m, src: string, st: string, loc: string) => {
      const where = [st, loc].filter((x) => x !== "—");
      return `from ${src}, ${where.length ? `in ${where.join(", ")}` : "with no state or town given"}`;
    })
    .trim();
  detail = detail.replace(/^an? (\d+)-digit number(, given with a country code)?, which is not one we can text$/,
    (_m, n: string, plus: string | undefined) => untextableDigits(Number(n), !!plus));
  const lead = REASON_LEAD[code];
  if (!lead) return cap(detail);
  return detail ? `${lead}: ${detail}` : lead;
}

/** The digit count of a refused number, said correctly. Shared with lead-intake. */
export function untextableDigits(n: number, withCountryCode: boolean): string {
  if (withCountryCode) return `${n} digits with a country code, which is not a number we can text`;
  // Ten digits that toE164 still refused: a 0 or 1 where an area code or
  // exchange must start 2-9, or the 555-01 range kept for fiction and tests.
  if (n === 10 || n === 11) return `${n} digits, but not a valid US number`;
  return `${n} digit${n === 1 ? "" : "s"}, where a US number has 10`;
}

/** A redrive hold reason (`"<stored reason>" will not answer differently`), readable. */
export function plainHoldReason(why: string): string {
  const m = /^"([\s\S]*)" will not answer differently$/.exec(why);
  if (!m) return cap(why);
  return `${plainLeadReason(m[1])}. Retrying will not change that.`;
}
