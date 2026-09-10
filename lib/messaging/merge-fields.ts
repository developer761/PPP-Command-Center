/**
 * Filling the blanks in a campaign message.
 *
 * The seeded opener says "Call us at {{workspace_phone}}", because the number
 * differs per workspace and a hardcoded one would send Nassau customers to the
 * Queens office. Nothing substituted it, so the first message of every
 * conversation would have gone out with the placeholder still in it.
 *
 * THE REFUSAL IS THE IMPORTANT HALF. Any {{...}} left after substitution means
 * a field nobody defined, and the right answer is to refuse rather than send.
 * A message reading "Call us at {{workspace_phone}}" is worse than no message:
 * it is visibly broken to the customer, it is the first thing they ever see
 * from PPP, and it cannot be unsent.
 *
 * Pure.
 */
import { toE164 } from "./phone";

export type MergeValues = {
  workspacePhone?: string | null;
  workspaceName?: string | null;
  customerName?: string | null;
  officeLocation?: string | null;
};

/** Dashed, matching how Emily writes a number in the conversations Kate graded well. */
function displayNumber(raw: string | null | undefined): string | null {
  const e = raw ? toE164(raw) : null;
  if (!e) return raw?.trim() || null;
  const d = e.replace(/^\+1/, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : e;
}

/** First name only. "Hi Jeremy Saxe" reads like a form letter. */
function firstName(full: string | null | undefined): string | null {
  const t = (full ?? "").trim();
  if (!t) return null;
  return t.split(/\s+/)[0];
}

export const MERGE_PATTERN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/**
 * The fields this system knows how to fill.
 *
 * Exported so a screen can tell the difference between a placeholder that WILL
 * be filled at send time and one nobody has ever defined. Without that
 * distinction the campaign page flagged the seeded opener as broken — its
 * {{workspace_phone}} is correct and deliberate — and Kate would have been
 * unable to publish a perfectly good campaign.
 */
export const KNOWN_MERGE_FIELDS = [
  "workspace_phone", "workspace_name", "customer_name", "office_location",
] as const;

export function isKnownMergeField(name: string): boolean {
  return (KNOWN_MERGE_FIELDS as readonly string[]).includes(name.toLowerCase());
}

export function fillMergeFields(body: string, values: MergeValues): string {
  const map: Record<string, string | null> = {
    workspace_phone: displayNumber(values.workspacePhone),
    workspace_name: values.workspaceName?.trim() || null,
    customer_name: firstName(values.customerName),
    office_location: values.officeLocation?.trim() || null,
  };
  return body.replace(MERGE_PATTERN, (whole, key: string) => {
    const v = map[key.toLowerCase()];
    // Left in place when there is no value, so unresolved() catches it and the
    // send is refused. Silently blanking it would produce "Call us at  with
    // any questions", which is worse — it looks like a typo rather than a bug
    // and would not be noticed.
    return v ?? whole;
  });
}

/** Every placeholder still unfilled. Empty means the message is safe to send. */
export function unresolvedFields(body: string): string[] {
  return [...body.matchAll(MERGE_PATTERN)].map((m) => m[1]);
}

export function hasUnresolved(body: string): boolean {
  return unresolvedFields(body).length > 0;
}
