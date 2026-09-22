import { describe, it, expect } from "vitest";
import {
  statusFromTwilio, shouldApply, isFailure, failureNote, CARRIER_FILTERED,
} from "@/lib/messaging/delivery";

/**
 * delivery_status was written once as "sent" and never updated, and
 * failure_reason was never written at all — so a message a carrier filtered
 * looked exactly like one that arrived, forever, on every screen.
 */
describe("reading Twilio's vocabulary", () => {
  it("maps the states our column has", () => {
    expect(statusFromTwilio("queued")).toBe("queued");
    expect(statusFromTwilio("sent")).toBe("sent");
    expect(statusFromTwilio("delivered")).toBe("delivered");
    expect(statusFromTwilio("undelivered")).toBe("undelivered");
    expect(statusFromTwilio("failed")).toBe("failed");
  });

  it("collapses the states our column does not have", () => {
    // sending is a sent that has not landed; read is a delivered somebody
    // opened, which only happens on RCS. Neither loses anything we report on.
    expect(statusFromTwilio("sending")).toBe("sent");
    expect(statusFromTwilio("read")).toBe("delivered");
    expect(statusFromTwilio("accepted")).toBe("queued");
  });

  it("does not guess at a status it has never seen", () => {
    // Writing a value the CHECK constraint refuses would throw on a webhook
    // Twilio then retries forever.
    expect(statusFromTwilio("teleported")).toBeNull();
    expect(statusFromTwilio("")).toBeNull();
    expect(statusFromTwilio(null)).toBeNull();
  });

  it("does not care about case or stray whitespace", () => {
    expect(statusFromTwilio(" Delivered ")).toBe("delivered");
  });
});

describe("a delivered message never becomes undelivered", () => {
  it("moves forward through the ladder", () => {
    expect(shouldApply("queued", "sent")).toBe(true);
    expect(shouldApply("sent", "delivered")).toBe(true);
  });

  it("refuses a late callback that would walk it backwards", () => {
    // Twilio does not promise ordering and it RETRIES callbacks, so a late
    // "sent" arriving after "delivered" would otherwise un-deliver a message
    // that actually landed.
    expect(shouldApply("delivered", "sent")).toBe(false);
    expect(shouldApply("sent", "queued")).toBe(false);
  });

  it("lets a failure overwrite anything, because that is the fact worth keeping", () => {
    expect(shouldApply("delivered", "failed")).toBe(true);
    expect(shouldApply("sent", "undelivered")).toBe(true);
  });

  it("does not let a failure be overwritten by good news", () => {
    expect(shouldApply("failed", "delivered")).toBe(false);
    expect(shouldApply("undelivered", "sent")).toBe(false);
  });

  it("applies anything to a row with no status yet", () => {
    expect(shouldApply(null, "queued")).toBe(true);
    expect(shouldApply(undefined, "delivered")).toBe(true);
    expect(shouldApply("something_old", "sent")).toBe(true);
  });

  it("knows which states mean it will never arrive", () => {
    expect(isFailure("failed")).toBe(true);
    expect(isFailure("undelivered")).toBe(true);
    expect(isFailure("delivered")).toBe(false);
    expect(isFailure("sent")).toBe(false);
  });
});

describe("saying why, in words somebody can act on", () => {
  it("explains carrier filtering, which is the one to watch after the port", () => {
    const note = failureNote(CARRIER_FILTERED, "Message filtered");
    expect(note).toMatch(/30007/);
    expect(note).toMatch(/filtered/i);
    // The actionable half: on a new campaign this means registration or
    // content, not a bad phone number.
    expect(note).toMatch(/registration|content/i);
  });

  it("explains an unreachable handset differently", () => {
    expect(failureNote(30003, "Unreachable destination handset")).toMatch(/unreachable|not a mobile/i);
  });

  it("still says something useful for a code it does not recognise", () => {
    expect(failureNote(21610, "Unsubscribed recipient")).toBe("Unsubscribed recipient (21610)");
  });

  it("never renders an empty reason", () => {
    expect(failureNote(null, null)).toBe("no reason given");
    expect(failureNote(null, "   ")).toBe("no reason given");
  });
});
