import { describe, it, expect } from "vitest";
import { parseKateTranscript, storedTranscript } from "@/lib/messaging/kate-transcript";
import { turnsOf, isRepairable } from "@/lib/messaging/repair";

/** Her sheet, as the PDF text comes out: one run, no line per message. */
const CABINETS =
  "--- 2026-08-30 ---[1] 02:41 [SMS] CAMPAIGN: Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! Could you share details about your project and your availability for an appointment? Call us at [PHONE] with any inquiries. Reply END to stop texts." +
  "[2] 02:42 [SMS] CUSTOMER: Have 11 lower office cabinets that need painting plus 2 rooms" +
  "[3] 02:43 [SMS] AI (Emily): Got it. Could you share the full address for the project, including the zip code?" +
  "[4] 02:43 [SMS] CUSTOMER: [ZIP]" +
  "[5] 02:43 [SMS] AI (Emily): Great. Could you share the street address for the project?" +
  "[6] 02:44 [SMS] CUSTOMER: Would prefer to get a call to schedule" +
  "[7] 02:44 [SMS] AI (Emily): Great, thanks! We look forward to connecting with you by phone.\n" +
  "7 turns | 0 not delivered | 0 AI-composed-not-sent";

describe("Kate's numbered transcript", () => {
  it("keeps her order and her attribution: the campaign opener is T1, not Emily", () => {
    const r = parseKateTranscript(CABINETS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.turns.map((t) => `T${t.turn} ${t.speaker}`)).toEqual([
      "T1 Campaign", "T2 Customer", "T3 Emily", "T4 Customer", "T5 Emily", "T6 Customer", "T7 Emily",
    ]);
  });

  it("stores it so the repair screen reads the same numbers and speakers back", () => {
    const r = parseKateTranscript(CABINETS);
    if (!r.ok) throw new Error(r.error);
    const back = turnsOf(storedTranscript(r.turns));
    expect(back.map((t) => `T${t.turn} ${t.speaker}`)).toEqual(r.turns.map((t) => `T${t.turn} ${t.speaker}`));
    expect(back[1].text).toBe("Have 11 lower office cabinets that need painting plus 2 rooms");
  });

  it("does not let a campaign message be repaired as if Emily wrote it", () => {
    const r = parseKateTranscript(CABINETS);
    if (!r.ok) throw new Error(r.error);
    const back = turnsOf(storedTranscript(r.turns));
    expect(isRepairable(back[0])).toBe(false);
    expect(isRepairable(back[2])).toBe(true);
  });

  it("reads human agents, emails, calls and a conversation over several days", () => {
    const block =
      "--- 2026-07-01 ---[1] 09:00 [SMS] CAMPAIGN: Hi from PPP.[2] 09:15 [EMAIL] CAMPAIGN: Your estimate request" +
      "[3] 10:00 [CALL] CUSTOMER: (call, 2 min)--- 2026-07-02 ---[4] 15:00 [SMS] HUMAN AGENT:  ** SENT ** We passed it on." +
      "[5] 15:01 [SMS] CUSTOMER:  👍 to “ We passed it on. ”\n5 turns | 1 not delivered";
    const r = parseKateTranscript(block);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.turns.map((t) => [t.speaker, t.channel])).toEqual([
      ["Campaign", "SMS"], ["Campaign", "EMAIL"], ["Customer", "CALL"], ["Human agent", "SMS"], ["Customer", "SMS"],
    ]);
    expect(r.turns[2].text).toBe("(call, 2 min)");
    const stored = storedTranscript(r.turns);
    expect(stored).toContain("Campaign: [Email] Your estimate request");
    expect(turnsOf(stored)).toHaveLength(5);
  });

  it("keeps Hatch's after-hours auto-reply as its own speaker, never Emily", () => {
    const r = parseKateTranscript(
      "[1] 09:00 [SMS] CAMPAIGN: hi[2] 23:10 [SMS] CUSTOMER: can you come tomorrow?[3] 23:10 [SMS] AUTO-REPLY: Thanks for reaching out! We are closed.\n3 turns | 0 not delivered");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = turnsOf(storedTranscript(r.turns));
    expect(back.map((t) => t.speaker)).toEqual(["Campaign", "Customer", "Auto-reply"]);
    expect(isRepairable(back[2])).toBe(false);
  });

  it("refuses rather than guesses when her count and the messages disagree", () => {
    const r = parseKateTranscript(CABINETS.replace("7 turns", "8 turns"));
    expect(r.ok).toBe(false);
  });

  it("refuses a speaker it does not know, instead of folding it into the message above", () => {
    const r = parseKateTranscript("[1] 09:00 [SMS] CAMPAIGN: hi[2] 09:01 [SMS] SYSTEM BOT: x\n2 turns | 0 not delivered");
    expect(r.ok).toBe(false);
  });

  it("refuses a jump in her numbering", () => {
    const r = parseKateTranscript("[1] 09:00 [SMS] CAMPAIGN: hi[3] 09:01 [SMS] CUSTOMER: x\n2 turns | 0 not delivered");
    expect(r.ok).toBe(false);
  });
});
