import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A task you assign to yourself is not a team announcement.
 *
 * Every Slack post in this file deliberately runs BEFORE and OUTSIDE the
 * recipient check. That is correct for company facts: the channel is the room
 * the team watches, and "invoice paid" is exactly as true when the deal has no
 * assignees. Gating those on recipients would make the channel silently
 * incomplete in the one case nobody would think to check.
 *
 * `commercial_task_assigned` is the exception, because it is not a company
 * fact. The dispatcher self-skips it — `actingUserId === recipientUserId`
 * bails — so assigning a task to yourself correctly rings no bell. The channel
 * post did not skip, so every personal to-do landed in the team channel worded
 * "<name> assigned you a task", in a room where "you" is nobody.
 *
 * ── Why this test is shaped the way it is ─────────────────────────────────
 *
 * The suite is DB-free and has no Slack, so this cannot observe a post. What
 * it CAN do is hold the asymmetry still in both directions, which is the whole
 * risk: someone reading the "posts before the recipient check" comment and
 * making tasks match it again, or someone reading THIS fix and gating the
 * money events too.
 */

const src = readFileSync(
  join(process.cwd(), "lib/notifications/commercial-events.ts"),
  "utf8"
);

/** Body of one exported notification function, by name. */
function fnBody(name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport async function ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/**
 * The same body with COMMENTS STRIPPED.
 *
 * The first version of the ordering test below compared raw offsets and went
 * red against correct code, because the comment explaining the fix contains
 * the words `if (recipients.length === 0) return` — so the "gate" it found was
 * prose, not a gate. Anything asserting on WHERE something sits has to measure
 * the code.
 */
function fnCode(name: string): string {
  return fnBody(name)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("a self-assigned task", () => {
  const body = fnBody("insertCommercialTaskAssignedNotification");

  it("computes whether the actor IS the assignee", () => {
    expect(body).toMatch(
      /const selfAssigned\s*=\s*!!input\.actingUserId && input\.actingUserId === input\.recipientUserId/
    );
  });

  it("does not post to the channel in that case", () => {
    // THE REGRESSION: postCommercialSlack sitting at the top level of this
    // function, reachable no matter who the task is for.
    expect(body).toMatch(/if \(!selfAssigned\) \{[\s\S]{0,400}postCommercialSlack\(/);
  });

  it("uses the SAME rule the bell uses, so the two cannot drift", () => {
    // The dispatcher's self-skip is `actingUserId === recipientUserId` and
    // this function does not pass allowSelfNotify — so bell and channel now
    // agree. If someone adds allowSelfNotify here, the guard above has to be
    // reconsidered at the same time, and this states why.
    expect(body).not.toContain("allowSelfNotify");
    expect(body).toContain("kind: \"commercial_task_assigned\"");
  });

  it("still posts when the task is for somebody else", () => {
    // Guarding on `selfAssigned` and not on "are there recipients" is the
    // point — a real assignment must still reach the channel.
    const guard = body.slice(body.indexOf("const selfAssigned"));
    expect(guard).not.toMatch(/if \(recipients\.length === 0\)[\s\S]{0,200}postCommercialSlack/);
  });
});

describe("the company-fact events are deliberately NOT gated", () => {
  /**
   * These are the ones whose Slack post must keep firing regardless of who is
   * assigned. If a future change gates them on the recipient check, the
   * channel goes quiet exactly when a deal has nobody on it — which is the
   * case worth hearing about.
   */
  const companyFacts = [
    "insertCommercialInvoicePaidNotifications",
    "insertCommercialProposalSentNotifications",
    "insertCommercialInvoiceCreatedNotifications",
    "insertCommercialInvoicePaymentRecordedNotifications",
  ];

  for (const name of companyFacts) {
    it(`${name} posts before and outside the recipient check`, () => {
      const code = fnCode(name);
      const slackAt = code.indexOf("postCommercialSlack(");
      const gateAt = code.indexOf("if (recipients.length === 0) return");
      expect(slackAt, `${name}: no Slack post`).toBeGreaterThan(-1);
      if (gateAt > -1) {
        // THE REGRESSION, and it was live: invoice_created and
        // payment_recorded both gated first, so an invoice on a deal with no
        // assignee produced no bell, no email and no channel post. 130 of 132
        // live deals have no assignee.
        expect(slackAt, `${name}: Slack must post BEFORE the recipient gate`).toBeLessThan(gateAt);
      }
      // …and must not have picked up a self-assignment guard by copy-paste.
      expect(code, `${name}: should not be self-gated`).not.toContain("const selfAssigned =");
    });
  }
});
