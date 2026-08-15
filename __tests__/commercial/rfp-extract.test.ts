import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractRfp } from "@/lib/commercial/rfp/extract";

/** The fail-SOFT guards — extractRfp must never throw; a bad input or missing
 *  key returns {ok:false} with a human message so the UI shows a banner and the
 *  person fills the form by hand. (The happy path hits the Anthropic API and is
 *  covered by manual testing, not a unit test.) */
describe("extractRfp guards", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("rejects empty / too-short text before calling the API", async () => {
    expect((await extractRfp("")).ok).toBe(false);
    expect((await extractRfp("   ")).ok).toBe(false);
    expect((await extractRfp("short")).ok).toBe(false);
  });

  it("returns a soft error (never throws) when no API key is configured", async () => {
    const r = await extractRfp("Invitation to bid: paint the lobby at 5 Main St, due 2026-09-01. — Turner");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ANTHROPIC_API_KEY|isn't configured/i);
  });

  it("rejects absurdly long input rather than shipping it to the API", async () => {
    const huge = "x".repeat(61_000);
    const r = await extractRfp(huge);
    expect(r.ok).toBe(false);
  });
});
