/**
 * The rule that decides whether a sold deal is written unattended.
 *
 * Karan's requirement was "1000 percent accurate … and automatic as well", and
 * the thing that makes both possible is that the ambiguity is a CLOSED SET:
 * Katie stopped Salesforce entry on 2026-10-14, so a deal raised after that
 * cannot have a twin there.
 *
 * The asymmetry drives every threshold here. A wrong hold costs one click. A
 * wrong insert puts a second copy of a real sale into the number Katie runs the
 * company on, and nothing downstream flags it, because both records look
 * legitimate. So every case below that is genuinely uncertain must HOLD.
 */
import { describe, expect, it } from "vitest";
import { decideWriteBack, HOLD_SCORE, SHOW_SCORE, SF_ENTRY_STOPPED } from "@/lib/salesforce/tomco-decide";
import type { SfCandidate, SoldDeal } from "@/lib/salesforce/tomco-pairing";

const CUTOVER = "2026-10-14";

function cand(over: Partial<SfCandidate> & { sfId: string; name: string }): SfCandidate {
  return { accountName: null, stageName: "Estimate Sent", closeDate: null, subtotalCents: null, alreadyPaired: false, ...over };
}
function deal(over: Partial<SoldDeal> = {}): SoldDeal {
  return { id: "deal-1", title: "A Job", accountName: null, contractCents: null, decidedAt: "2026-10-13", ...over };
}
const BEFORE = { dealCreatedAt: "2026-09-01T00:00:00Z", cutover: CUTOVER };
const AFTER = { dealCreatedAt: "2026-10-20T00:00:00Z", cutover: CUTOVER };

/** The real twins, from production on 2026-10-14. */
const CUMMINS = cand({ sfId: "006cummins", name: "Cummins -Interior", accountName: "Cummins sales and Service", subtotalCents: 515_000, closeDate: "2026-10-10" });
const PCCI = cand({ sfId: "006pcci", name: "Facade Renovation-Eastport", accountName: "PCCI Builders Corp.", subtotalCents: 935_000, closeDate: "2026-09-23" });

describe("a deal already linked is simply updated", () => {
  it("updates, whatever else is open", () => {
    const plan = decideWriteBack({
      deal: deal({ title: "MotorMindz" }),
      pairedSfId: "006Wj00000hDlTNIA0",
      openCandidates: [CUMMINS, PCCI],
      ...BEFORE,
    });
    expect(plan.action).toBe("update");
    if (plan.action === "update") expect(plan.sfId).toBe("006Wj00000hDlTNIA0");
  });

  it("covers the 94 of 98 that came out of Salesforce", () => {
    // No candidates needed — the link is the whole answer.
    const plan = decideWriteBack({ deal: deal(), pairedSfId: "006x", openCandidates: [], ...BEFORE });
    expect(plan.action).toBe("update");
  });
});

describe("🔴 the two real twins are HELD, never auto-inserted", () => {
  it("holds Cummins — same account, amount to the cent", () => {
    const plan = decideWriteBack({
      deal: deal({ id: "d-cummins", title: "Cummins", accountName: "Cummins Sales and Service", contractCents: 515_000 }),
      pairedSfId: null,
      openCandidates: [CUMMINS, PCCI],
      ...BEFORE,
    });
    expect(plan.action).toBe("hold");
    if (plan.action === "hold") expect(plan.candidates[0].sfId).toBe("006cummins");
  });

  it("holds PCCI — the price moved, so only the account and name connect them", () => {
    const plan = decideWriteBack({
      deal: deal({ id: "d-pcci", title: "PCCI Builders Corp. Eastport Facade Renovation", accountName: "PCCI Builders Corp.", contractCents: 890_000 }),
      pairedSfId: null,
      openCandidates: [CUMMINS, PCCI],
      ...BEFORE,
    });
    expect(plan.action).toBe("hold");
    if (plan.action === "hold") expect(plan.candidates[0].sfId).toBe("006pcci");
  });

  it("holds on the account alone, even with no amount and no shared words", () => {
    // The deliberately low bar: a GC with a live estimate is enough to ask.
    const plan = decideWriteBack({
      deal: deal({ title: "Something Else Entirely", accountName: "PCCI Builders Corp." }),
      pairedSfId: null,
      openCandidates: [PCCI],
      ...BEFORE,
    });
    expect(plan.action).toBe("hold");
  });
});

describe("the genuinely new ones go through unattended", () => {
  it("inserts Thermo Fisher — nothing open on that account", () => {
    const plan = decideWriteBack({
      deal: deal({ title: "Thermo Fisher Inspection Room & Exterior Door Painting P.O. 718210", accountName: "Thermo Fisher", contractCents: 537_500 }),
      pairedSfId: null,
      openCandidates: [CUMMINS, PCCI],
      ...BEFORE,
    });
    expect(plan.action).toBe("insert");
    expect(plan.why).toMatch(/Checked all 2/);
  });

  it("inserts when Salesforce has no open estimates at all, and says so", () => {
    const plan = decideWriteBack({ deal: deal(), pairedSfId: null, openCandidates: [], ...BEFORE });
    expect(plan.action).toBe("insert");
    expect(plan.why).toMatch(/No open Tomco estimates/);
  });
});

describe("the cutover is what makes this automatic", () => {
  it("inserts a deal raised AFTER entry stopped, even against a high scorer", () => {
    // The whole basis for running unattended: nobody could have created a
    // Salesforce twin after this date, so a strong score is a coincidence.
    const plan = decideWriteBack({
      deal: deal({ title: "Cummins", accountName: "Cummins Sales and Service", contractCents: 515_000 }),
      pairedSfId: null,
      openCandidates: [CUMMINS],
      ...AFTER,
    });
    expect(plan.action).toBe("insert");
    expect(plan.why).toMatch(/cannot have a twin/);
  });

  it("holds the SAME deal when it predates the cutover", () => {
    // Identical input but for the creation date — proving the date is doing
    // the work, not something else in the shape of the record.
    const plan = decideWriteBack({
      deal: deal({ title: "Cummins", accountName: "Cummins Sales and Service", contractCents: 515_000 }),
      pairedSfId: null,
      openCandidates: [CUMMINS],
      ...BEFORE,
    });
    expect(plan.action).toBe("hold");
  });

  it("keys on when the deal was CREATED, not when it sold", () => {
    // A deal raised in September and sold in November could still have been
    // entered in Salesforce back in September.
    const plan = decideWriteBack({
      deal: deal({ title: "Cummins", accountName: "Cummins Sales and Service", decidedAt: "2026-11-30" }),
      pairedSfId: null,
      openCandidates: [CUMMINS],
      dealCreatedAt: "2026-09-01T00:00:00Z",
      cutover: CUTOVER,
    });
    expect(plan.action).toBe("hold");
  });

  it("holds when the creation date is unknown", () => {
    // Absent evidence is not evidence of safety.
    const plan = decideWriteBack({
      deal: deal({ title: "Cummins", accountName: "Cummins Sales and Service" }),
      pairedSfId: null,
      openCandidates: [CUMMINS],
      dealCreatedAt: null,
      cutover: CUTOVER,
    });
    expect(plan.action).toBe("hold");
  });

  it("treats the cutover day itself as still risky", () => {
    const plan = decideWriteBack({
      deal: deal({ title: "Cummins", accountName: "Cummins Sales and Service" }),
      pairedSfId: null,
      openCandidates: [CUMMINS],
      dealCreatedAt: `${CUTOVER}T23:59:00Z`,
      cutover: CUTOVER,
    });
    expect(plan.action).toBe("hold");
  });
});

describe("a candidate already linked to another deal is not a reason to hold", () => {
  it("inserts rather than queueing a choice nobody can make", () => {
    // It is already somebody else's, so it is not a candidate — holding on it
    // would park the deal forever behind an unresolvable question.
    const taken = { ...CUMMINS, alreadyPaired: true };
    const plan = decideWriteBack({
      deal: deal({ title: "Cummins", accountName: "Cummins Sales and Service", contractCents: 515_000 }),
      pairedSfId: null,
      openCandidates: [taken],
      ...BEFORE,
    });
    expect(plan.action).toBe("insert");
  });
});

describe("the threshold itself", () => {
  it("holds at the threshold and inserts below it", () => {
    // Pinned so a future tweak to the ranker's weights cannot quietly turn a
    // hold into an auto-insert without this going red.
    const justOver = cand({ sfId: "a", name: "x", accountName: "Same Co" });
    const plan = decideWriteBack({
      deal: deal({ accountName: "Same Co" }),
      pairedSfId: null,
      openCandidates: [justOver],
      ...BEFORE,
    });
    expect(plan.action).toBe("hold");
    expect(HOLD_SCORE).toBeLessThanOrEqual(50); // below a lone account match
  });

  it("the cutover constant is the date Katie actually gave", () => {
    expect(SF_ENTRY_STOPPED).toBe("2026-10-14");
  });
});

describe("the queue shows what resembles the job, and counts the rest", () => {
  /**
   * Seen on the rendered page: a $5,150 deal was offered `AVR-Lot C` at
   * $385,882.22 and `127 S. Fourth St.` at $35,287.60 — scored on closing
   * within 90 days and nothing else. Five of eight entries were noise.
   *
   * That works against accuracy rather than for it. A list full of obvious
   * non-answers teaches a reader to skim, and skimming is how the wrong
   * "same job" gets clicked.
   */
  const noise = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      cand({ sfId: `noise${i}`, name: `Unrelated Job ${i}`, accountName: "Someone Else", subtotalCents: 38_588_222, closeDate: "2026-10-01" }),
    );

  it("lists only candidates that resemble the job", () => {
    const plan = decideWriteBack({
      deal: deal({ title: "Cummins", accountName: "Cummins Sales and Service", contractCents: 515_000 }),
      pairedSfId: null,
      openCandidates: [CUMMINS, ...noise(10)],
      ...BEFORE,
    });
    expect(plan.action).toBe("hold");
    if (plan.action !== "hold") return;
    // The real twin, and nothing scored on date proximity alone.
    expect(plan.candidates.map((c) => c.sfId)).toEqual(["006cummins"]);
    expect(plan.othersChecked).toBe(10);
  });

  it("still counts them, because 'we looked at 43' is the reassuring part", () => {
    const plan = decideWriteBack({
      deal: deal({ accountName: "PCCI Builders Corp." }),
      pairedSfId: null,
      openCandidates: [PCCI, ...noise(42)],
      ...BEFORE,
    });
    if (plan.action !== "hold") throw new Error("expected a hold");
    expect(plan.candidates.length + plan.othersChecked).toBe(43);
  });

  it("never hides a candidate that caused the hold", () => {
    // The floor must sit below the hold threshold, or a deal could be held on
    // a record the screen does not show — which would be unanswerable.
    expect(SHOW_SCORE).toBeLessThan(HOLD_SCORE);
  });
});
