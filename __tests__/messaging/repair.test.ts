import { describe, it, expect } from "vitest";
import { turnsOf, applyRepairs, changedTurns, repairNote, isRepairable } from "@/lib/messaging/repair";

/** The cabinets conversation Kate repaired on 2026-09-15, as stored. */
const CABINETS = [
  "Customer: Have 11 lower office cabinets that need painting plus 2 rooms",
  "Emily: Hello, this is Precision Painting Plus. Thanks for requesting a free estimate!",
  "Emily: Got it. Could you share the full address for the project, including the zip code?",
  "Customer: [ZIP]",
  "Emily: Great. Could you share the street address for the project?",
  "Customer: Would prefer to get a call to schedule",
  "Emily: Great, thanks! We look forward to connecting with you by phone.",
].join("\n");

/** A form submission: one message over six stored lines. */
const FORM = [
  "Customer: Hi! I need help with chipping and peeling paint on an exterior shed.",
  "",
  "",
  "Availability:",
  "Monday 8/17 - 12pm or after ",
  "Tuesday 8/18 - 12pm or after",
  "Emily: Hello, this is Precision Painting Plus.",
  "Emily: Thank you! Checking our schedule now.",
  "Customer: ok",
  "Emily: What is the address?",
].join("\n");

describe("turn numbers match Kate's sheet", () => {
  // Her note on this conversation: the full-address ask was T3, and the bot
  // "had to come back at T5 with the street ask".
  it("puts her T3 and T5 on the lines she meant", () => {
    const t = turnsOf(CABINETS);
    expect(t.find((x) => x.turn === 3)?.text).toContain("full address");
    expect(t.find((x) => x.turn === 5)?.text).toContain("street address");
  });

  it("counts a multi-line form submission as one turn, not six", () => {
    const t = turnsOf(FORM);
    expect(t.map((x) => x.speaker)).toEqual(["Customer", "Emily", "Emily", "Customer", "Emily"]);
    expect(t[0].text).toContain("Availability:");
    expect(t[0].text).toContain("Tuesday 8/18");
    expect(t[4].turn).toBe(5);
  });

  it("does not treat Availability as a speaker", () => {
    expect(turnsOf(FORM).some((x) => x.speaker === "Availability")).toBe(false);
  });

  it("only lets Emily's lines be repaired", () => {
    const t = turnsOf(CABINETS);
    expect(isRepairable(t[0])).toBe(false);
    expect(isRepairable(t[2])).toBe(true);
  });
});

describe("one repair, several lines", () => {
  it("fixes T3 and T5 together and leaves everything else alone", () => {
    const r = applyRepairs({
      transcript: CABINETS,
      fixes: [
        { turn: 5, replacement: "Thanks. What time works for a call?" },
        { turn: 3, replacement: "What is the street address? I have the zip." },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = turnsOf(r.transcript);
    expect(t).toHaveLength(7);
    expect(t[2].text).toBe("What is the street address? I have the zip.");
    expect(t[4].text).toBe("Thanks. What time works for a call?");
    expect(t[3].text).toBe("[ZIP]");
    expect(r.changed.map((c) => c.turn)).toEqual([3, 5]);
  });

  it("replaces a whole multi-line message without moving the turns after it", () => {
    const multi = "Customer: hi\nEmily: line one\nline two\nline three\nCustomer: ok\nEmily: bye";
    const r = applyRepairs({ transcript: multi, fixes: [{ turn: 2, replacement: "One line now." }, { turn: 4, replacement: "Talk soon." }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript).toBe("Customer: hi\nEmily: One line now.\nCustomer: ok\nEmily: Talk soon.");
  });

  it("is all or nothing: one bad fix saves none of them", () => {
    const r = applyRepairs({ transcript: CABINETS, fixes: [{ turn: 3, replacement: "Fine." }, { turn: 4, replacement: "not allowed" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("T4");
  });

  it("refuses a fix that would invent a customer line", () => {
    const r = applyRepairs({ transcript: CABINETS, fixes: [{ turn: 3, replacement: "What is the street?\nCustomer: 12 Main St" }] });
    expect(r.ok).toBe(false);
  });

  it("refuses the same turn twice, a turn that is not there, and no change", () => {
    expect(applyRepairs({ transcript: CABINETS, fixes: [{ turn: 3, replacement: "a" }, { turn: 3, replacement: "b" }] }).ok).toBe(false);
    expect(applyRepairs({ transcript: CABINETS, fixes: [{ turn: 99, replacement: "a" }] }).ok).toBe(false);
    expect(applyRepairs({ transcript: CABINETS, fixes: [{ turn: 3, replacement: "Got it. Could you share the full address for the project, including the zip code?" }] }).ok).toBe(false);
    expect(applyRepairs({ transcript: CABINETS, fixes: [] }).ok).toBe(false);
  });
});

describe("reopening a repair saved before fixes were stored per turn", () => {
  it("recovers which turns it changed from the transcripts alone", () => {
    const r = applyRepairs({ transcript: CABINETS, fixes: [{ turn: 3, replacement: "Street address? I have the zip." }] });
    if (!r.ok) throw new Error(r.error);
    expect(changedTurns(CABINETS, r.transcript)).toEqual([
      { turn: 3, from: "Got it. Could you share the full address for the project, including the zip code?", to: "Street address? I have the zip." },
    ]);
  });
});

describe("the note a reviewer reads", () => {
  it("names each turn and its codes", () => {
    const n = repairNote([
      { turn: 3, what: "Asked for the zip we had.", codes: ["A11"], from: "a", to: "b" },
      { turn: 5, what: "Recovery ask.", from: "c", to: "d" },
    ]);
    expect(n.split("\n")).toHaveLength(2);
    expect(n).toContain("T3 [A11]:");
    expect(n).toContain("T5:");
  });
});
