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

const SRC = readFileSync("lib/notifications/commercial-events.ts", "utf8");

type Fn = { name: string; body: string };

function eventFunctions(): Fn[] {
  const out: Fn[] = [];
  const re = /export async function (insertCommercial\w+)\(/g;
  const hits = [...SRC.matchAll(re)];
  hits.forEach((m, i) => {
    const start = m.index!;
    const end = i + 1 < hits.length ? hits[i + 1].index! : SRC.length;
    out.push({ name: m[1], body: SRC.slice(start, end) });
  });
  return out;
}

describe("notification coverage", () => {
  const fns = eventFunctions();

  it("finds the event functions at all", () => {
    // A rename would otherwise make every check below pass vacuously.
    expect(fns.length, "no insertCommercial* functions found").toBeGreaterThan(12);
  });

  it("every event posts to Slack", () => {
    const missing = fns.filter((f) => !f.body.includes("postCommercialSlack")).map((f) => f.name);
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
    const noEmail = fns.filter(
      (f) => !f.body.includes("dispatchCommercialNotification") && !f.body.includes("await sendEmail(")
    ).map((f) => f.name);
    expect(noEmail, `These no longer send email:\n${noEmail.join("\n")}`).toEqual([]);
  });
});
