import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { archiveBccFor, withArchiveBcc } from "@/lib/commercial/email-archive/auto-bcc";

/**
 * Everything we send a GC files itself into that job's archive.
 *
 * Karan, 2026-09-21, looking at an empty Email tab: "everything should [be]
 * here as well." The archive only captured mail a human remembered to BCC,
 * which is why it held ZERO rows after four days of live use — the platform
 * was sending invoices, proposals and change orders straight past its own
 * record of them.
 *
 * The risky part is not the filing, it is the send. A BCC list is passed
 * straight to Resend, so every way this helper can misbehave costs an invoice:
 * a null recipient rejects the whole message, a duplicate can bounce it, and a
 * throw takes the send down with it. Each of those is pinned below.
 */

const OPP = "6a35ba1f-186f-4776-a45d-d6f4426a87db";
const ACC = "f2ac9d67-7064-492f-baee-a520dc3ae97e";

const realSecret = process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET;
beforeEach(() => {
  process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET = "test-secret-at-least-16-chars-long";
});
afterEach(() => {
  if (realSecret === undefined) delete process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET;
  else process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET = realSecret;
});

describe("the archive BCC", () => {
  it("files against the JOB when there is one", () => {
    const [addr] = archiveBccFor({ opportunityId: OPP, accountId: ACC });
    expect(addr).toMatch(/\+archive-opp-/);
  });

  it("files against the GC when there is no job", () => {
    const [addr] = archiveBccFor({ accountId: ACC });
    expect(addr).toMatch(/\+archive-acc-/);
  });

  it("falls back to the GC rather than not filing at all", () => {
    // `commercial_invoices.opportunity_id` is nullable. An invoice with no
    // deal must still land somewhere.
    expect(archiveBccFor({ opportunityId: null, accountId: ACC })).toHaveLength(1);
    expect(archiveBccFor({ opportunityId: "", accountId: ACC })[0]).toMatch(/\+archive-acc-/);
  });

  it("returns NOTHING when there is no id at all", () => {
    expect(archiveBccFor({})).toEqual([]);
    expect(archiveBccFor({ opportunityId: null, accountId: null })).toEqual([]);
  });

  it("returns NOTHING when the archive is unconfigured", () => {
    // buildArchiveAddress returns null without the HMAC secret, because an
    // address it can't verify inbound would be silently dropped. A null pushed
    // into a BCC array is an invalid recipient and Resend rejects the WHOLE
    // send — which would turn a missing archive copy into a failed invoice.
    delete process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET;
    expect(archiveBccFor({ opportunityId: OPP })).toEqual([]);
  });

  it("never returns a null or an empty string", () => {
    for (const t of [{ opportunityId: OPP }, { accountId: ACC }, {}]) {
      for (const a of archiveBccFor(t)) {
        expect(a).toBeTruthy();
        expect(a).toContain("@");
      }
    }
  });
});

describe("merging it into an existing BCC list", () => {
  it("keeps the copies already on the message", () => {
    const out = withArchiveBcc(["mary@tomcopainting.com"], { opportunityId: OPP });
    expect(out).toContain("mary@tomcopainting.com");
    expect(out).toHaveLength(2);
  });

  it("does not duplicate an address already BCC'd", () => {
    const [addr] = archiveBccFor({ opportunityId: OPP });
    const out = withArchiveBcc([addr], { opportunityId: OPP });
    expect(out).toEqual([addr]);
  });

  it("does not add it when it is already a visible recipient", () => {
    // Someone pasting the archive address into To or CC would otherwise get
    // two copies, and a duplicate recipient can bounce the send.
    const [addr] = archiveBccFor({ opportunityId: OPP });
    expect(withArchiveBcc([], { opportunityId: OPP }, [addr])).toEqual([]);
    expect(withArchiveBcc([], { opportunityId: OPP }, [addr.toUpperCase()])).toEqual([]);
  });

  it("ignores null and empty entries in the visible list", () => {
    // Callers pass `ccEmail`, which is legitimately null.
    const out = withArchiveBcc([], { opportunityId: OPP }, [null, undefined, "", "  "]);
    expect(out).toHaveLength(1);
  });

  it("returns the list unchanged when the archive is off", () => {
    delete process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET;
    const existing = ["mary@tomcopainting.com", "brendan@tomcopainting.com"];
    expect(withArchiveBcc(existing, { opportunityId: OPP })).toEqual(existing);
  });
});

describe("every GC-facing sender uses it", () => {
  const SENDERS = [
    ["lib/commercial/invoices/email.ts", "the invoice"],
    ["lib/commercial/invoices/statement-email.ts", "the statement"],
    ["lib/commercial/proposals/email.ts", "the proposal"],
    ["lib/commercial/change-orders/email.ts", "the change order"],
    ["lib/commercial/esign/workflow.ts", "the signature request"],
  ] as const;

  for (const [path, what] of SENDERS) {
    it(`${what} archives itself`, () => {
      const src = readFileSync(join(process.cwd(), path), "utf8");
      expect(src, `${path} does not archive`).toContain("withArchiveBcc(");
    });

    it(`${what} passes the visible recipients so it cannot double-send`, () => {
      const src = readFileSync(join(process.cwd(), path), "utf8");
      const call = src.slice(src.indexOf("withArchiveBcc("));
      // Third argument is the to/cc list — without it the de-dupe in rule 3
      // only sees the BCC list and a pasted archive address slips through.
      expect(call.slice(0, 400)).toMatch(/\[\s*to/);
    });
  }
});

describe("the Sent/Received split", () => {
  const hubRaw = readFileSync(join(process.cwd(), "lib/commercial/email-archive/hub.ts"), "utf8");
  /** Comments stripped — the docblock explaining this bug NAMES the dead
   *  column, so asserting on raw source goes red against the fix. Fourth time
   *  today a check in this repo read its own explanation. Assert on code. */
  const hub = hubRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("no longer reads a column that does not exist", () => {
    // THE BUG: `select("email, reply_to_email")` — reply_to_email is not a
    // column on commercial_operating_company, so PostgREST rejected the whole
    // select, ourDomains was always empty, and EVERY archived email was
    // labelled "Received" while the banner told you to fix it in Settings.
    expect(hub).not.toContain("reply_to_email");
  });

  it("learns our domains from what we actually send as", () => {
    expect(hub).toContain("commercialSenderDomains()");
  });

  it("reports a failed company lookup instead of silently answering wrong", () => {
    expect(hubRaw).toMatch(/companyErr[\s\S]{0,300}console\.warn/);
  });
});
