/**
 * Loading Kate's rules for the bot.
 *
 * A MODULE OF ITS OWN, and that is the point. It reads sms_class_a_rules and
 * nothing else — it does not know sms_class_a_rule_notes exists, so the
 * rater-only guidance Kate marked "NEVER give this to a bot" cannot travel
 * through here even by accident. Anything that wants that text has to go and
 * ask for it somewhere else, deliberately, which is the whole reason it lives
 * in a second table.
 *
 * CACHED, because these change when Kate re-issues a sheet — a few times a
 * month at most — and reading 44 rows on every single agent turn is a database
 * round trip for an answer that is the same all day. Five minutes means a
 * re-import is picked up without a deploy and without anyone waiting.
 */
import { messagingDb } from "./db";
import type { ClassARule } from "./class-a-rules";

let cached: { rules: ClassARule[]; at: number } | null = null;
const TTL_MS = 5 * 60_000;

/** For tests, and for the moment right after an import. */
export function clearClassARuleCache(): void {
  cached = null;
}

export async function loadClassARules(): Promise<ClassARule[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.rules;

  const sb = messagingDb();
  const { data, error } = await sb
    .from("sms_class_a_rules")
    // Named columns, not *. Not for safety — the rater-only text is not in
    // this table at all — but so a column added later has to be considered
    // before it starts appearing in every prompt.
    .select("code, statement, rule_card, corrective_action, severity, status, phrasing_only, binds, source, measured_breaches, change_type, last_modified, last_re_rated")
    .eq("status", "live");

  // FAILS TO NOTHING, on purpose, and this is the one place in the messaging
  // code where that is right. The rules make the bot better; they are not a
  // rail. If this table cannot be read, the correct outcome is the prompt the
  // system had yesterday — not a customer left unanswered because a
  // supplementary instruction set was briefly unavailable. The gate still
  // refuses everything it refused before.
  if (error) {
    // Not cached: a blip should not silently mean no rules for five minutes.
    return [];
  }

  const rules: ClassARule[] = (data ?? []).map((r) => ({
    code: r.code as string,
    statement: r.statement as string,
    ruleCard: (r.rule_card as string | null) ?? null,
    correctiveAction: (r.corrective_action as string | null) ?? null,
    severity: (r.severity as "critical" | "mild" | null) ?? null,
    status: (r.status as "live" | "retired") ?? "live",
    phrasingOnly: !!r.phrasing_only,
    binds: r.binds !== false,
    source: (r.source as string | null) ?? null,
    measuredBreaches: (r.measured_breaches as string | null) ?? null,
    changeType: (r.change_type as string | null) ?? null,
    lastModified: (r.last_modified as string | null) ?? null,
    lastReRated: (r.last_re_rated as string | null) ?? null,
  }));

  cached = { rules, at: now };
  return rules;
}
