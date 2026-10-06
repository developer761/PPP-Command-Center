import { describe, it, expect } from "vitest";
import { classifyInbound, isPlainLanguageOptOut } from "@/lib/messaging/compliance";
import { ASKED_FOR_A_CALL } from "@/lib/messaging/customer-asks";

/**
 * "DON'T TEXT ME, JUST CALL ME" — A CHANNEL, NOT A GOODBYE.
 *
 * Kate, 2026-10-05: "Yes if they ask for us to stop texting and to call, it's
 * okay to route to a person. I don't think this is considered an explicit
 * opt-out, just a communication preference."
 *
 * Found in the simulator 2026-09-27 with every step behaving as written and
 * the outcome still wrong: the number is suppressed (correct — A24 reads
 * "don't text me" as a revocation) and then the thread ended as `discard`, so
 * nothing recorded that this customer had asked to be CALLED. Somebody who
 * asked us to phone them was filed as somebody who asked us to go away.
 *
 * ── WHAT THIS FILE IS REALLY GUARDING ───────────────────────────────────
 *
 * Only HALF her answer is taken. The ROUTING is hers and is built. Whether the
 * number stays suppressed is NOT hers — "don't text me" is a revocation of
 * consent for texts whatever we call it, and that is Katie's call with Karan.
 * Suppressing somebody who need not have been costs one text; failing to
 * suppress somebody who should have been costs $500-$1,500 a message.
 *
 * So the test that matters most here is the one asserting the suppression did
 * NOT move. A change that routes these to a person and quietly stops
 * suppressing them would look like a feature and be a compliance incident.
 */
describe("the suppression is unchanged — this is the half that is not Kate's", () => {
  it.each([
    "dont text me just call me",
    "don't text me, just call me",
    "stop texting me and call me instead",
    "quit texting me, phone me instead",
  ])("still classifies %j as an opt-out", (text) => {
    expect(classifyInbound(text)).toBe("opt_out");
    expect(isPlainLanguageOptOut(text)).toBe(true);
  });

  /** A plain opt-out with no call request is untouched in every respect. */
  it.each(["stop", "STOP", "unsubscribe", "take me off your list", "leave me alone"])(
    "leaves a plain opt-out alone: %j", (text) => {
      expect(classifyInbound(text)).toBe("opt_out");
      expect(ASKED_FOR_A_CALL.test(text)).toBe(false);
    }
  );
});

/**
 * THE ROUTING HALF. recordInbound reads exactly these two conditions together
 * — classifyInbound says opt_out AND ASKED_FOR_A_CALL matches — to send the
 * thread to a person instead of ending it. Asserted on the two detectors
 * rather than against a database, which keeps it a test of the RULE.
 */
describe("a text-stop that asks for a call is recognised as both", () => {
  it.each([
    "dont text me just call me",
    "don't text me, just call me",
    "stop texting me and call me instead",
    "no more texts, please call me",
  ])("%j is an opt-out AND a call request", (text) => {
    expect(classifyInbound(text)).toBe("opt_out");
    expect(ASKED_FOR_A_CALL.test(text)).toBe(true);
  });

  /**
   * AND IN SPANISH, because ASKED_FOR_A_CALL is the detector A25 already uses
   * and it is bilingual — which is the reason to reuse it rather than write a
   * second pattern that would have been English only.
   */
  it("works in Spanish too", () => {
    const text = "no me manden mas mensajes, que me llamen por favor";
    expect(classifyInbound(text)).toBe("opt_out");
    expect(ASKED_FOR_A_CALL.test(text)).toBe(true);
  });

  /**
   * THE LINE THAT MUST NOT MOVE. A plain opt-out has to keep ending the
   * conversation — routing every STOP to a person would put somebody who
   * clearly wants nothing more from us in front of a human to be looked at.
   */
  it.each(["stop", "unsubscribe", "take me off your list", "quítenme de la lista"])(
    "does not read %j as a call request", (text) => {
      expect(ASKED_FOR_A_CALL.test(text)).toBe(false);
    }
  );

  /** And a call request that is NOT an opt-out stays A25's, not this path's. */
  it.each(["please call me instead of texting", "could you call me today?"])(
    "leaves %j as a normal message for A25", (text) => {
      expect(classifyInbound(text)).toBe("normal");
      expect(ASKED_FOR_A_CALL.test(text)).toBe(true);
    }
  );

  /**
   * NOT COVERED, AND SAYING SO RATHER THAN PRETENDING. ASKED_FOR_A_CALL wants
   * a word like call/phone/speak/talk, so idioms miss: "give me a ring",
   * "buzz me". That is A25's detector and widening it reaches several callers,
   * so it is left alone here rather than changed as a side effect of a
   * compliance fix. Such a message simply stays a plain opt-out, which is the
   * safe direction — suppressed, not routed.
   */
  it("does not pretend to catch idioms", () => {
    expect(ASKED_FOR_A_CALL.test("can someone give me a ring?")).toBe(false);
  });
});
