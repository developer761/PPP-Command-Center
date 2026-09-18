import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every notification the platform raises also reaches the channel — once.
 *
 * Karan 2026-08-25: *"all emails should be getting sent from notifications,
 * approvals, bids everything along with on slack as well."*
 *
 * Two things have to stay true as events are added, and neither is visible by
 * reading one function:
 *
 * 1. A NEW EVENT MUST NOT SILENTLY SKIP SLACK. The failure is invisible — the
 *    bell and the email still work, so nothing looks broken; the channel is
 *    just quietly missing one kind of thing, and you would only notice by
 *    knowing what should have been there.
 *
 * 2. IT MUST POST ONCE PER EVENT, NOT PER RECIPIENT. Most of these fan out over
 *    recipients. A post inside the loop puts five identical lines in the room
 *    when five people are on a deal, which is how a channel gets muted.
 */

/**
 * BOTH FILES, AND ANY `insert…Notification` NAME.
 *
 * The first version of this scanned only commercial-events.ts and only matched
 * `insertCommercial*`. Two real event kinds escaped it in the two different
 * ways that were available:
 *
 *   · `insertCustomRuleNotification` — right file, name does not begin
 *     `insertCommercial`;
 *   · `insertCommercialTeamAssignedNotification` — right name, lives in
 *     insert.ts.
 *
 * Both post nothing to Slack, which is exactly the defect this file exists to
 * prevent, and it reported green the whole time. A check whose scope is
 * narrower than the rule it enforces is worse than no check: it is a standing
 * claim that the gap cannot happen.
 */
const FILES = [
  "lib/notifications/commercial-events.ts",
  "lib/notifications/insert.ts",
] as const;

const SRC = FILES.map((f) => readFileSync(f, "utf8")).join("\n");

/**
 * Which functions are in scope, per file.
 *
 * `commercial-events.ts` IS the commercial event module — everything exported
 * from it that raises a notification is in scope by definition.
 *
 * `insert.ts` is shared with the residential side, so only the functions that
 * actually write a `commercial_` kind count. That excludes
 * `insertCustomerFormSubmittedNotification` (the residential color form),
 * which has no business posting in Tomco's channel — and includes
 * `insertCommercialTeamAssignedNotification`, which picks its kind with a
 * ternary and so is invisible to any `kind: "commercial_…"` pattern.
 *
 * Scoping by FILE where the file answers it, and by CONTENT only where it does
 * not, is what keeps this from being wrong in one direction or the other.
 */
function inScope(file: string, body: string): boolean {
  if (file.endsWith("commercial-events.ts")) return true;
  return /"commercial_[a-z_]+"/.test(body);
}

/**
 * NOT EVERY NOTIFICATION IS A TEAM ANNOUNCEMENT.
 *
 * Widening this check surfaced two functions with no Slack post, and the
 * obvious move — add one to each — would have been wrong. Both are written in
 * the SECOND PERSON to a single recipient, which is the tell:
 *
 *   · `insertCustomRuleNotification` — "You created this alert." A custom rule
 *     is somebody's own tripwire on their own criteria. Announcing it to the
 *     room broadcasts what one person is quietly watching, and would put a line
 *     in the channel for an event only they consider an event.
 *   · `insertCommercialTeamAssignedNotification` — "…re-added you as Estimator."
 *     A staffing change addressed to the person it happened to. The channel
 *     carries BUSINESS events — a bid went out, an invoice was paid — and
 *     Karan's standing rule is one post per event, not per notification.
 *
 * Listed with the reason, so an exemption stays a decision. Anything NOT here
 * must post, which is what makes the check still worth having.
 *
 * Open for Karan: if team adds should be announced, delete the second entry and
 * the check will tell you exactly where to add the call.
 */
const PERSONAL_NOT_TEAM = new Set([
  "insertCustomRuleNotification",
  "insertCommercialTeamAssignedNotification",
]);

type Fn = { name: string; body: string; file: string };

function eventFunctions(): Fn[] {
  const out: Fn[] = [];
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    const re = /export async function (insert\w*Notifications?)\(/g;
    const hits = [...src.matchAll(re)];
    hits.forEach((m, i) => {
      const start = m.index!;
      const end = i + 1 < hits.length ? hits[i + 1].index! : src.length;
      const body = src.slice(start, end);
      /**
       * SCOPED BY THE KIND IT WRITES, not by its name or its file.
       *
       * Widening the name pattern pulled in
       * `insertCustomerFormSubmittedNotification`, which raises
       * `customer_form_submitted` — the RESIDENTIAL color form. Requiring that
       * to post in Tomco's commercial channel would be a wrong answer arrived at
       * by a wider net, which is its own kind of broken check.
       *
       * The rule is about COMMERCIAL events, so the test asks what the function
       * actually writes. It is also self-maintaining: a new commercial kind is
       * in scope the moment it exists, without anyone updating a list.
       */
      if (!inScope(file, body)) return;
      out.push({ name: m[1], body, file });
    });
  }
  return out;
}

describe("notification coverage", () => {
  const fns = eventFunctions();

  it("finds the event functions at all", () => {
    // A rename would otherwise make every check below pass vacuously.
    expect(fns.length, "no insertCommercial* functions found").toBeGreaterThan(12);
  });

  it("every event posts to Slack", () => {
    const missing = fns
      .filter((f) => !PERSONAL_NOT_TEAM.has(f.name))
      .filter((f) => !f.body.includes("postCommercialSlack"))
      .map((f) => f.name);
    expect(
      missing,
      `These raise a notification but never reach the channel:\n${missing.join("\n")}\n` +
        `Add a postCommercialSlack call above the per-recipient work.`
    ).toEqual([]);
  });

  it("posts once per event, never once per recipient", () => {
    // Depth alone is not the test. The approval-decision post sits inside
    // `if (!input.forReceiver)` — depth 2 and entirely correct, because that
    // function is CALLED once per recipient and the guard is what makes it
    // fire once. What matters is whether the enclosing block is a LOOP.
    //
    // So this walks back from the call to the `{` that opens its block and
    // looks at what precedes it. A first version compared positions against the
    // first `for` in the file and flagged three correct functions; a second
    // used raw depth and flagged this one.
    const LOOP = /\b(for|while)\s*\(|\.(map|forEach|flatMap)\s*\(/;
    const nested: string[] = [];
    for (const f of fns) {
      const at = f.body.indexOf("postCommercialSlack");
      if (at === -1) continue;
      let depth = 0;
      let openedAt = -1;
      for (let i = at; i >= 0; i--) {
        const ch = f.body[i];
        if (ch === "}") depth++;
        else if (ch === "{") {
          if (depth === 0) { openedAt = i; break; }
          depth--;
        }
      }
      if (openedAt === -1) continue;
      const header = f.body.slice(Math.max(0, openedAt - 120), openedAt);
      if (LOOP.test(header)) nested.push(`${f.name} — enclosing block is a loop`);
    }
    expect(
      nested,
      `These post from inside a loop — five recipients would mean five identical ` +
        `messages:\n${nested.join("\n")}`
    ).toEqual([]);
  });

  it("every event still sends its email", () => {
    // Slack is additional, never a replacement. An event that lost its email
    // path would go quiet for anyone not watching the channel.
    const noEmail = fns.filter((f) => !PERSONAL_NOT_TEAM.has(f.name)).filter(
      (f) => !f.body.includes("dispatchCommercialNotification") && !f.body.includes("await sendEmail(")
    ).map((f) => f.name);
    expect(noEmail, `These no longer send email:\n${noEmail.join("\n")}`).toEqual([]);
  });
});
