/**
 * Stephanie 2026-10-14: "Is there a way to have everyone cc'd when a proposal
 * does go out from Command? Me, Kim, Brendan, and Mary just so we can stay on
 * top of the goings on?"
 *
 * Two traps are pinned here.
 *
 * 1. PROPOSAL_COPY_EMAILS is the BCC *and* the Reply-To, so the obvious
 *    implementation — add three addresses to it — would have copied them in AND
 *    redirected every GC reply to four extra inboxes. The next person to read
 *    that env var will be tempted by the same one-line change.
 *
 * 2. The saved list must win over the environment even when it is EMPTY.
 *    Falling back on an empty list would make "remove the last watcher" quietly
 *    restore whatever the env var still held — a setting that will not stay off.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const ENV_COPY = "COMMERCIAL_PROPOSAL_COPY_EMAILS";
const ENV_NOTIFY = "COMMERCIAL_PROPOSAL_NOTIFY_EMAILS";

/** What `commercial_settings` holds for the watcher key in a given case. */
let settingsRow: { value: unknown } | null = null;
let settingsError: string | null = null;
const writes: Array<{ key: string; value: unknown; userId: string | null }> = [];

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            settingsError
              ? { data: null, error: { message: settingsError } }
              : { data: settingsRow, error: null },
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/commercial/settings", () => ({
  setCommercialSetting: async (key: string, value: unknown, userId?: string | null) => {
    writes.push({ key, value, userId: userId ?? null });
  },
}));

/** The reply-to list is read at import time, so each case re-imports. */
async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const k of [ENV_COPY, ENV_NOTIFY]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return import("@/lib/commercial/proposals/copy-emails");
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved[ENV_COPY] = process.env[ENV_COPY];
  saved[ENV_NOTIFY] = process.env[ENV_NOTIFY];
  settingsRow = null;
  settingsError = null;
  writes.length = 0;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

describe("the office can edit the list themselves", () => {
  it("BCCs whoever is saved in settings, and leaves Reply-To alone", async () => {
    settingsRow = { value: ["stephanie@tomcopainting.com", "mary@tomcopainting.com"] };
    const m = await load({
      [ENV_COPY]: "brendan@tomcopainting.com,developer@precisionpaintingplus.net",
    });
    // THE ASK: everyone saved gets a copy, alongside the standing two.
    expect(await m.proposalBccList()).toEqual([
      "brendan@tomcopainting.com",
      "developer@precisionpaintingplus.net",
      "stephanie@tomcopainting.com",
      "mary@tomcopainting.com",
    ]);
    // THE THING THAT MUST NOT CHANGE: replies still go to Brendan + ops only.
    expect(m.PROPOSAL_COPY_EMAILS).toEqual([
      "brendan@tomcopainting.com",
      "developer@precisionpaintingplus.net",
    ]);
  });

  it("saves a pasted list as a validated array", async () => {
    const m = await load();
    const stored = await m.setProposalNotifyEmails(
      " Stephanie@TomcoPainting.com; mary@tomcopainting.com\n not-an-email ",
      "user-1",
    );
    expect(stored).toEqual(["stephanie@tomcopainting.com", "mary@tomcopainting.com"]);
    expect(writes).toEqual([
      {
        key: "proposal_notify_emails",
        value: ["stephanie@tomcopainting.com", "mary@tomcopainting.com"],
        userId: "user-1",
      },
    ]);
  });

  it("an EMPTY saved list means nobody — it does not fall back to the env var", async () => {
    settingsRow = { value: [] };
    const m = await load({ [ENV_NOTIFY]: "someone-old@tomcopainting.com" });
    expect(await m.getProposalNotifyEmails()).toEqual([]);
    expect(await m.proposalBccList()).toEqual(m.PROPOSAL_COPY_EMAILS);
  });

  it("uses the env var only until the setting has ever been saved", async () => {
    settingsRow = null; // no row yet
    const m = await load({ [ENV_NOTIFY]: "bootstrap@tomcopainting.com" });
    expect(await m.getProposalNotifyEmails()).toEqual(["bootstrap@tomcopainting.com"]);
  });

  it("de-duplicates Brendan, who belongs on both lists by description", async () => {
    settingsRow = { value: ["brendan@tomcopainting.com", "kim@tomcopainting.com"] };
    const m = await load({ [ENV_COPY]: "brendan@tomcopainting.com" });
    const bcc = await m.proposalBccList();
    expect(bcc).toEqual(["brendan@tomcopainting.com", "kim@tomcopainting.com"]);
    // A repeated address in a BCC header is how a provider sends two copies.
    expect(bcc.filter((e) => e === "brendan@tomcopainting.com")).toHaveLength(1);
  });

  it("keeps Brendan and the ops inbox as the default when nothing is configured", async () => {
    const m = await load();
    expect(await m.proposalBccList()).toEqual([
      "brendan@tomcopainting.com",
      "developer@precisionpaintingplus.net",
    ]);
  });
});

describe("a settings problem cannot stop a proposal reaching its GC", () => {
  it("falls back to the env list when the settings read fails", async () => {
    settingsError = "connection reset";
    const m = await load({
      [ENV_COPY]: "brendan@tomcopainting.com",
      [ENV_NOTIFY]: "mary@tomcopainting.com",
    });
    await expect(m.proposalBccList()).resolves.toEqual([
      "brendan@tomcopainting.com",
      "mary@tomcopainting.com",
    ]);
  });

  it("tolerates a legacy comma-string value instead of an array", async () => {
    settingsRow = { value: "stephanie@tomcopainting.com,mary@tomcopainting.com" };
    const m = await load();
    expect(await m.getProposalNotifyEmails()).toEqual([
      "stephanie@tomcopainting.com",
      "mary@tomcopainting.com",
    ]);
  });

  it("drops a typo rather than handing it to the mailer", async () => {
    settingsRow = { value: ["kim@tomcopainting.com", "not-an-email", ""] };
    const m = await load();
    expect(await m.getProposalNotifyEmails()).toEqual(["kim@tomcopainting.com"]);
  });
});

describe("parseList takes addresses the way people paste them", () => {
  it("splits on commas, semicolons, newlines and spaces, and de-duplicates", async () => {
    const m = await load();
    expect(
      m.parseList("a@x.com, b@x.com; c@x.com\nd@x.com e@x.com\t a@x.com"),
    ).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
  });

  it("returns nothing for an empty or junk value", async () => {
    const m = await load();
    expect(m.parseList("")).toEqual([]);
    expect(m.parseList("   ,  ; ")).toEqual([]);
  });
});

describe("nobody is both CC'd and BCC'd", () => {
  /*
   * THE BUG THIS REPLACES A WORSE TEST FOR.
   *
   * The first version of this block grepped the source for
   * "await proposalBccList()" and passed — while the RESULT was being filtered
   * against `ccEmail`, the comma-joined display string. With two CCs,
   * `e !== "kim@x.com, mary@x.com"` is always true, so anyone both CC'd and on
   * the copy list stayed in cc AND bcc. A source-text assertion cannot see a
   * correctly-called function whose answer is then misused — exactly what
   * AGENTS.md means by testing the artifact rather than the file.
   *
   * These assert on the COMPUTED recipient sets instead.
   */
  it("drops a CC'd address from the BCC when there are TWO CCs", async () => {
    settingsRow = { value: ["stephanie@tomcopainting.com", "mary@tomcopainting.com"] };
    const m = await load({ [ENV_COPY]: "brendan@tomcopainting.com,developer@precisionpaintingplus.net" });
    const cc = ["kim@tomcopainting.com", "mary@tomcopainting.com"];
    const bcc = m.dropVisible(await m.proposalBccList(), "pm@acmegc.com", cc);
    expect(bcc).not.toContain("mary@tomcopainting.com");
    expect(bcc).toEqual(["brendan@tomcopainting.com", "developer@precisionpaintingplus.net", "stephanie@tomcopainting.com"]);
    // The real defect, stated as an invariant: no overlap between cc and bcc.
    expect(bcc.filter((e) => cc.includes(e))).toEqual([]);
  });

  it("drops Brendan when he is CC'd, even with no watchers configured", async () => {
    // The live case on the day this was found: Brendan is CC'd on proposals by
    // convention AND is on the standing copy list, so he was duplicated before
    // the watcher feature was ever switched on.
    const m = await load({ [ENV_COPY]: "brendan@tomcopainting.com,developer@precisionpaintingplus.net" });
    const bcc = m.dropVisible(await m.proposalBccList(), "pm@acmegc.com", [
      "brendan@tomcopainting.com",
      "pm2@acmegc.com",
    ]);
    expect(bcc).toEqual(["developer@precisionpaintingplus.net"]);
  });

  it("still works for one CC, and for none", async () => {
    const m = await load({ [ENV_COPY]: "brendan@tomcopainting.com,developer@precisionpaintingplus.net" });
    const list = await m.proposalBccList();
    expect(m.dropVisible(list, "pm@acmegc.com", ["brendan@tomcopainting.com"])).toEqual([
      "developer@precisionpaintingplus.net",
    ]);
    expect(m.dropVisible(list, "pm@acmegc.com", [])).toEqual(list);
  });

  it("drops the TO address, and matches regardless of case or padding", async () => {
    const m = await load({ [ENV_COPY]: "brendan@tomcopainting.com,developer@precisionpaintingplus.net" });
    const bcc = m.dropVisible(await m.proposalBccList(), " Brendan@TomcoPainting.com ", [
      "  DEVELOPER@precisionpaintingplus.net  ",
    ]);
    expect(bcc).toEqual([]);
  });

  it("both send paths route their BCC through dropVisible", async () => {
    // Kept as a seam check, but on the CALL rather than on a mention: the
    // signature takes string[], so a mis-call no longer compiles, and this only
    // has to prove the helper is on the path at all. Comments stripped so a
    // docblock naming it cannot pass for using it.
    const { readFileSync } = await import("node:fs");
    for (const f of ["lib/commercial/proposals/email.ts", "lib/commercial/esign/workflow.ts"]) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, `${f} should await the combined list`).toContain("await proposalBccList()");
    }
    const proposalSrc = readFileSync("lib/commercial/proposals/email.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(proposalSrc).toContain("dropVisible(");
    // And the thing that actually broke: the joined display string must not be
    // what the BCC is filtered against.
    expect(proposalSrc).not.toMatch(/filter\([^)]*!==\s*ccEmail/);
  });
});
