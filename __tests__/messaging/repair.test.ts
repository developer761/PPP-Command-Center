import { describe, it, expect } from "vitest";
import { turnsOf, applyRepairs, changedTurns, repairNote, isRepairable } from "@/lib/messaging/repair";

/** The cabinets conversation as stored now: real order, real speakers. */
const CABINETS = [
  "Campaign: Hello, this is Precision Painting Plus. Thanks for requesting a free estimate!",
  "Customer: Have 11 lower office cabinets that need painting plus 2 rooms",
  "Emily: Got it. Could you share the full address for the project, including the zip code?",
  "Customer: [ZIP]",
  "Emily: Great. Could you share the street address for the project?",
  "Customer: Would prefer to get a call to schedule",
  "Emily: Great, thanks! We look forward to connecting with you by phone.",
].join("\n");

/** A form submission: one message over six stored lines. */
const FORM = [
  "Campaign: Hello, this is Precision Painting Plus.",
  "Customer: Hi! I need help with chipping and peeling paint on an exterior shed.",
  "",
  "",
  "Availability:",
  "Monday 8/17 - 12pm or after ",
  "Tuesday 8/18 - 12pm or after",
  "Emily: Thank you! Checking our schedule now.",
  "Customer: ok",
  "Emily: What is the address?",
].join("\n");

describe("turn numbers match Kate's sheet", () => {
  // Kate, 2026-09-15: T1 is the customer's first message; the campaign message
  // before it is shown, unnumbered, as "Previous Campaign Message".
  it("numbers the conversation from the customer's first message", () => {
    const t = turnsOf(CABINETS);
    expect(t.map((x) => (x.turn === null ? x.label : `T${x.turn} ${x.label}`))).toEqual([
      "Previous Campaign Message",
      "T1 Customer", "T2 Emily", "T3 Customer", "T4 Emily", "T5 Customer", "T6 Emily",
    ]);
  });

  it("shows a campaign message mid-conversation unnumbered, and names it for what it precedes", () => {
    const t = turnsOf([
      "Campaign: opener", "Customer: hi", "Emily: what is the address?",
      "Campaign: Hi, just following up on your estimate request.",
      "Emily: still there?",
      "Auto-reply: We are closed.", "Customer: yes",
    ].join("\n"));
    expect(t.map((x) => [x.turn, x.label])).toEqual([
      [null, "Previous Campaign Message"], [1, "Customer"], [2, "Emily"],
      [null, "Campaign Message"], [3, "Emily"], [null, "Auto-reply"], [4, "Customer"],
    ]);
  });

  it("counts a multi-line form submission as one turn, not six", () => {
    const t = turnsOf(FORM).filter((x) => x.turn !== null);
    expect(t.map((x) => x.speaker)).toEqual(["Customer", "Emily", "Customer", "Emily"]);
    expect(t[0].text).toContain("Availability:");
    expect(t[0].text).toContain("Tuesday 8/18");
    expect(t[3].turn).toBe(4);
  });

  it("does not treat Availability as a speaker", () => {
    expect(turnsOf(FORM).some((x) => x.speaker === "Availability")).toBe(false);
  });

  it("only lets Emily's lines be repaired", () => {
    const t = turnsOf(CABINETS);
    expect(isRepairable(t[0])).toBe(false); // campaign
    expect(isRepairable(t[1])).toBe(false); // customer
    expect(isRepairable(t[2])).toBe(true);
  });
});

describe("one repair, several lines", () => {
  it("fixes T2 and T4 together and leaves everything else alone", () => {
    const r = applyRepairs({
      transcript: CABINETS,
      fixes: [
        { turn: 4, replacement: "Thanks. What time works for a call?" },
        { turn: 2, replacement: "What is the street address? I have the zip." },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = turnsOf(r.transcript);
    expect(t).toHaveLength(7);
    expect(t.find((x) => x.turn === 2)?.text).toBe("What is the street address? I have the zip.");
    expect(t.find((x) => x.turn === 4)?.text).toBe("Thanks. What time works for a call?");
    expect(t[0].speaker).toBe("Campaign");
    expect(r.changed.map((c) => c.turn)).toEqual([2, 4]);
  });

  it("replaces a whole multi-line message without moving the turns after it", () => {
    const multi = "Customer: hi\nEmily: line one\nline two\nline three\nCustomer: ok\nEmily: bye";
    const r = applyRepairs({ transcript: multi, fixes: [{ turn: 2, replacement: "One line now." }, { turn: 4, replacement: "Talk soon." }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript).toBe("Customer: hi\nEmily: One line now.\nCustomer: ok\nEmily: Talk soon.");
  });

  it("is all or nothing: one bad fix saves none of them", () => {
    const r = applyRepairs({ transcript: CABINETS, fixes: [{ turn: 2, replacement: "Fine." }, { turn: 3, replacement: "not allowed" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("T3");
  });

  it("refuses a fix that would invent a customer line", () => {
    const r = applyRepairs({ transcript: CABINETS, fixes: [{ turn: 2, replacement: "What is the street?\nCustomer: 12 Main St" }] });
    expect(r.ok).toBe(false);
  });

  it("refuses the same turn twice, a turn that is not there, and no change", () => {
    expect(applyRepairs({ transcript: CABINETS, fixes: [{ turn: 2, replacement: "a" }, { turn: 2, replacement: "b" }] }).ok).toBe(false);
    expect(applyRepairs({ transcript: CABINETS, fixes: [{ turn: 99, replacement: "a" }] }).ok).toBe(false);
    expect(applyRepairs({ transcript: CABINETS, fixes: [{ turn: 2, replacement: "Got it. Could you share the full address for the project, including the zip code?" }] }).ok).toBe(false);
    expect(applyRepairs({ transcript: CABINETS, fixes: [] }).ok).toBe(false);
  });
});

describe("reopening a repair saved before fixes were stored per turn", () => {
  it("recovers which turns it changed from the transcripts alone", () => {
    const r = applyRepairs({ transcript: CABINETS, fixes: [{ turn: 2, replacement: "Street address? I have the zip." }] });
    if (!r.ok) throw new Error(r.error);
    expect(changedTurns(CABINETS, r.transcript)).toEqual([
      { turn: 2, from: "Got it. Could you share the full address for the project, including the zip code?", to: "Street address? I have the zip." },
    ]);
  });
});

describe("the note a reviewer reads", () => {
  it("names each turn and its codes", () => {
    const n = repairNote([
      { turn: 2, what: "Asked for the zip we had.", codes: ["A11"], from: "a", to: "b" },
      { turn: 4, what: "Recovery ask.", from: "c", to: "d" },
    ]);
    expect(n.split("\n")).toHaveLength(2);
    expect(n).toContain("T2 [A11]:");
    expect(n).toContain("T4:");
  });
});
