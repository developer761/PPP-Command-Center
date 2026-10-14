/**
 * Stephanie 2026-10-14: "Is there a way to have everyone cc'd when a proposal
 * does go out from Command? Me, Kim, Brendan, and Mary just so we can stay on
 * top of the goings on?"
 *
 * The trap this guards: PROPOSAL_COPY_EMAILS was both the BCC and the Reply-To,
 * so the obvious implementation — add three addresses to it — would have copied
 * them in AND redirected every GC reply to four extra inboxes. These tests pin
 * the separation, because the next person to read that env var will be tempted
 * by the same one-line change.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const ENV_COPY = "COMMERCIAL_PROPOSAL_COPY_EMAILS";
const ENV_NOTIFY = "COMMERCIAL_PROPOSAL_NOTIFY_EMAILS";

/** The module reads env at import time, so each case needs a fresh import. */
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const k of [ENV_COPY, ENV_NOTIFY]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return import("@/lib/commercial/proposals/copy-emails");
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved[ENV_COPY] = process.env[ENV_COPY];
  saved[ENV_NOTIFY] = process.env[ENV_NOTIFY];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

describe("the office watchers are copied but do not receive replies", () => {
  it("adds watchers to the BCC and leaves Reply-To alone", async () => {
    const m = await load({
      [ENV_COPY]: "brendan@tomcopainting.com,developer@precisionpaintingplus.net",
      [ENV_NOTIFY]: "stephanie@tomcopainting.com,kim@tomcopainting.com,mary@tomcopainting.com",
    });
    // THE ASK: all five get a copy.
    expect(m.proposalBccList()).toEqual([
      "brendan@tomcopainting.com",
      "developer@precisionpaintingplus.net",
      "stephanie@tomcopainting.com",
      "kim@tomcopainting.com",
      "mary@tomcopainting.com",
    ]);
    // THE THING THAT MUST NOT CHANGE: replies still go to Brendan + ops only.
    expect(m.PROPOSAL_COPY_EMAILS).toEqual([
      "brendan@tomcopainting.com",
      "developer@precisionpaintingplus.net",
    ]);
    expect(m.PROPOSAL_COPY_EMAILS).not.toContain("stephanie@tomcopainting.com");
  });

  it("de-duplicates Brendan, who belongs on both lists by description", async () => {
    const m = await load({
      [ENV_COPY]: "brendan@tomcopainting.com",
      [ENV_NOTIFY]: "brendan@tomcopainting.com,kim@tomcopainting.com",
    });
    expect(m.proposalBccList()).toEqual([
      "brendan@tomcopainting.com",
      "kim@tomcopainting.com",
    ]);
    // A repeated address in a BCC header is how a provider sends two copies.
    expect(m.proposalBccList().filter((e) => e === "brendan@tomcopainting.com")).toHaveLength(1);
  });

  it("changes nothing when no watchers are configured", async () => {
    const m = await load({
      [ENV_COPY]: "brendan@tomcopainting.com,developer@precisionpaintingplus.net",
    });
    expect(m.PROPOSAL_NOTIFY_EMAILS).toEqual([]);
    expect(m.proposalBccList()).toEqual(m.PROPOSAL_COPY_EMAILS);
  });

  it("keeps Brendan and the ops inbox as the default when nothing is set", async () => {
    const m = await load({});
    expect(m.PROPOSAL_COPY_EMAILS).toEqual([
      "brendan@tomcopainting.com",
      "developer@precisionpaintingplus.net",
    ]);
    expect(m.proposalBccList()).toHaveLength(2);
  });
});

describe("a typo in the watcher list cannot break a send", () => {
  it("drops malformed addresses instead of passing them to the mailer", async () => {
    const m = await load({
      [ENV_NOTIFY]: "kim@tomcopainting.com, not-an-email, ,mary@tomcopainting.com",
    });
    expect(m.PROPOSAL_NOTIFY_EMAILS).toEqual([
      "kim@tomcopainting.com",
      "mary@tomcopainting.com",
    ]);
  });

  it("normalises case and surrounding whitespace", async () => {
    const m = await load({
      [ENV_NOTIFY]: "  Stephanie@TomcoPainting.com  ,\tKIM@tomcopainting.com",
    });
    expect(m.PROPOSAL_NOTIFY_EMAILS).toEqual([
      "stephanie@tomcopainting.com",
      "kim@tomcopainting.com",
    ]);
  });

  it("treats an empty value as no watchers, not as one blank address", async () => {
    const m = await load({ [ENV_NOTIFY]: "" });
    expect(m.PROPOSAL_NOTIFY_EMAILS).toEqual([]);
  });
});

describe("both send paths use the combined list", () => {
  it("the proposal email and the signature email both call proposalBccList", async () => {
    // The signed contract matters as much as the proposal: an office that was
    // copied on the offer and not on the executed version is worse off than one
    // copied on neither. Asserted on the SEAM — that both modules import the
    // combined helper — rather than on prose in a comment.
    const { readFileSync } = await import("node:fs");
    for (const f of [
      "lib/commercial/proposals/email.ts",
      "lib/commercial/esign/workflow.ts",
    ]) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, `${f} should BCC the combined list`).toContain("proposalBccList()");
    }
  });
});
