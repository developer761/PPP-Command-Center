import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The bar answers "what needs me today" — for everything that does.
 *
 * Brendan asked for it ("a sticky bar on the top when an action happens"), and
 * the design rule is in the file: only things that put work in YOUR court, so
 * it never becomes a second, louder feed of everything.
 *
 * It covered three kinds, all in the proposal-approval loop. But a task
 * somebody assigned you, a task of yours that is now late, and a note with
 * your name in it are addressed to ONE PERSON — as much your court as an
 * approval request — and they were sitting in the bell, which is the passive
 * thing the bar exists to compensate for.
 */

const BAR = readFileSync("components/commercial/action-required-bar.tsx", "utf8");
const EVENTS = readFileSync("lib/notifications/commercial-events.ts", "utf8");

const PERSONAL = [
  "commercial_proposal_approval_requested",
  "commercial_proposal_changes_requested",
  "commercial_proposal_approved",
  "commercial_task_assigned",
  "commercial_task_overdue",
  "commercial_note_mention",
];

describe("action-required bar", () => {
  it("raises for every kind aimed at one named person", () => {
    for (const kind of PERSONAL) {
      expect(BAR, `${kind} is not in ACTIONABLE_KINDS`).toContain(`"${kind}"`);
    }
  });

  it("every raised kind tells you what to DO, not what happened", () => {
    // "Task assigned" is a description. "Open the task" is an instruction, and
    // the bar exists precisely because the passive version gets ignored.
    const cta = BAR.slice(BAR.indexOf("function ctaFor"), BAR.indexOf("export default"));
    for (const kind of PERSONAL) {
      expect(cta, `${kind} falls through to the generic "Open"`).toContain(kind);
    }
  });

  it("stays out of team-wide reminders", () => {
    // An overdue invoice or an expiring COI is the team's work, not a specific
    // person's. Putting those here turns "you are blocking something" into a
    // feed people learn to dismiss — which would cost the bar its meaning.
    for (const kind of [
      "commercial_invoice_dunning",
      "commercial_aia_dunning",
      "commercial_document_expiring",
      "commercial_hot_deal_cooling",
    ]) {
      expect(BAR, `${kind} would make the bar routine`).not.toContain(`"${kind}"`);
    }
  });

  it("every kind it lists is one the platform actually emits", () => {
    // A typo here fails silently: the bar simply never raises, and nobody can
    // tell the difference between "no work waiting" and "wrong string".
    const listed = [...BAR.matchAll(/"(commercial_[a-z_]+)"/g)].map((m) => m[1]);
    for (const kind of new Set(listed)) {
      expect(EVENTS, `"${kind}" is not emitted anywhere`).toContain(`"${kind}"`);
    }
  });
});
