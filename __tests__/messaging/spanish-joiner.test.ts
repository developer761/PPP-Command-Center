import { describe, it, expect } from "vitest";
import { listPhrase, spanishAnd } from "@/lib/messaging/services";
import { coveredPhrase } from "@/lib/messaging/agent-run";

/**
 * The joiner in a customer-facing list was always "and", including inside
 * Spanish sentences. Seen in the scenario harness 2026-10-12:
 *
 *   "Sí cubrimos interior painting, exterior painting, cabinets and drywall."
 */
describe("the list joiner follows the conversation's language", () => {
  it("still says 'and' in English, and by default", () => {
    expect(listPhrase(["a", "b", "c"])).toBe("a, b and c");
    expect(listPhrase(["a", "b"], "en")).toBe("a and b");
  });

  it("says 'y' in Spanish", () => {
    expect(listPhrase(["cocinas", "banos"], "es")).toBe("cocinas y banos");
    expect(listPhrase(["a", "b", "gabinetes"], "es")).toBe("a, b y gabinetes");
  });

  /**
   * "exterior painting y interior painting" is wrong Spanish. This fires in
   * practice, not in theory — "interior" is a service PPP sells.
   */
  it("says 'e' before an i- sound, which is the case that actually occurs", () => {
    expect(listPhrase(["exterior", "interior"], "es")).toBe("exterior e interior");
    expect(spanishAnd("interior")).toBe("e");
    expect(spanishAnd("impermeabilizacion")).toBe("e");
    expect(spanishAnd("hijos")).toBe("e");
  });

  it("keeps 'y' before hie-, where the rule does not hold", () => {
    expect(spanishAnd("hierro")).toBe("y");
  });

  it("keeps 'y' for ordinary words", () => {
    expect(spanishAnd("drywall")).toBe("y");
    expect(spanishAnd("gabinetes")).toBe("y");
  });

  it("is accent-aware", () => {
    expect(spanishAnd("índice")).toBe("e");
  });
});

describe("the covered-services phrase a customer is shown", () => {
  const svc = (label: string) => ({ label, covered: true }) as never;

  it("joins in Spanish when the conversation is Spanish", () => {
    expect(coveredPhrase([svc("Cabinets"), svc("Drywall")], "es")).toBe("cabinets y drywall");
    expect(coveredPhrase([svc("Exterior"), svc("Interior")], "es")).toBe("exterior e interior");
  });

  it("is unchanged in English", () => {
    expect(coveredPhrase([svc("Cabinets"), svc("Drywall")])).toBe("cabinets and drywall");
  });

  /** The truncation branch had its own hardcoded "and more". */
  it("translates the overflow tail too", () => {
    const five = ["a", "b", "c", "d", "e"].map(svc);
    expect(coveredPhrase(five, "es")).toBe("a, b, c, d y más");
    expect(coveredPhrase(five)).toBe("a, b, c, d and more");
  });
});
