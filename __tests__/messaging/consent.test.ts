import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  readSmsConsent, mayEnrol, requireExpressConsent,
} from "@/lib/messaging/consent";

/**
 * The gap Twilio found on 2026-10-10: SMS_Opt_In__c was read only to STOP a
 * conversation, never to decide whether to start one, and consent_basis was a
 * hardcoded constant. These tests pin the three states apart and pin the
 * default ON, which is the part that actually protects anybody.
 */
describe("reading SMS consent off a lead", () => {
  it("recognises the two opt-in values Salesforce actually sends", () => {
    expect(readSmsConsent({ SMS_Opt_In__c: "Opt-In (Verified)" }))
      .toEqual({ state: "express", value: "Opt-In (Verified)" });
    expect(readSmsConsent({ SMS_Opt_In__c: "Opt-In (Form)" }))
      .toEqual({ state: "express", value: "Opt-In (Form)" });
  });

  it("recognises an opt-out", () => {
    expect(readSmsConsent({ SMS_Opt_In__c: "Opt-Out" }))
      .toEqual({ state: "opted_out", value: "Opt-Out" });
  });

  it("is case and whitespace insensitive, because a picklist is typed by people", () => {
    expect(readSmsConsent({ SMS_Opt_In__c: "  opt-out  " }).state).toBe("opted_out");
    expect(readSmsConsent({ SMS_Opt_In__c: "OPT-IN (VERIFIED)" }).state).toBe("express");
  });

  /**
   * The distinction the whole file exists for. 1,576 of 1,584 live leads are
   * in this state, and reading it as a refusal would be as wrong as reading it
   * as permission.
   */
  it("treats a missing value as 'none', not as a refusal", () => {
    expect(readSmsConsent({})).toEqual({ state: "none", value: null });
    expect(readSmsConsent({ SMS_Opt_In__c: null })).toEqual({ state: "none", value: null });
    expect(readSmsConsent({ SMS_Opt_In__c: "" })).toEqual({ state: "none", value: null });
    expect(readSmsConsent({ SMS_Opt_In__c: "   " })).toEqual({ state: "none", value: null });
  });

  /**
   * A renamed picklist value must never read as permission. It still comes
   * back in `value` so it reaches the database and the check script instead of
   * being swallowed here.
   */
  it("treats an unrecognised value as 'none' but keeps it verbatim", () => {
    expect(readSmsConsent({ SMS_Opt_In__c: "Opted Out" }))
      .toEqual({ state: "none", value: "Opted Out" });
    expect(readSmsConsent({ SMS_Opt_In__c: "Opt-In (SMS Only)" }))
      .toEqual({ state: "none", value: "Opt-In (SMS Only)" });
  });
});

describe("whether a lead may be enrolled", () => {
  it("refuses an explicit opt-out whatever the policy", () => {
    const c = readSmsConsent({ SMS_Opt_In__c: "Opt-Out" });
    for (const requireExpress of [true, false]) {
      const r = mayEnrol(c, { requireExpress });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toMatch(/opted out/i);
    }
  });

  it("admits express consent whatever the policy", () => {
    const c = readSmsConsent({ SMS_Opt_In__c: "Opt-In (Verified)" });
    expect(mayEnrol(c, { requireExpress: true }).ok).toBe(true);
    expect(mayEnrol(c, { requireExpress: false }).ok).toBe(true);
  });

  /** The policy, and the only case where the switch changes the answer. */
  it("refuses an unknown-consent lead only when express consent is required", () => {
    const c = readSmsConsent({});
    expect(mayEnrol(c, { requireExpress: false }).ok).toBe(true);

    const strict = mayEnrol(c, { requireExpress: true });
    expect(strict.ok).toBe(false);
    expect(strict.ok === false && strict.reason).toMatch(/no SMS consent is recorded/);
  });

  it("names the unrecognised value in the refusal, so a rename is diagnosable", () => {
    const r = mayEnrol(readSmsConsent({ SMS_Opt_In__c: "Opted Out" }), { requireExpress: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("Opted Out");
  });
});

describe("the default is ON", () => {
  /**
   * Pinned hard, and deliberately not via the real process.env. The two
   * failures are not symmetrical: off, a flip enrols 1,576 leads nobody asked
   * and texts them; on, a flip enrols almost nobody and somebody asks why.
   * Anybody changing this default should have to change this test and read
   * why they are doing it.
   */
  it("requires express consent unless explicitly set to the string 'false'", () => {
    expect(requireExpressConsent({})).toBe(true);
    expect(requireExpressConsent({ SMS_REQUIRE_EXPRESS_CONSENT: "true" })).toBe(true);
    expect(requireExpressConsent({ SMS_REQUIRE_EXPRESS_CONSENT: "" })).toBe(true);
    expect(requireExpressConsent({ SMS_REQUIRE_EXPRESS_CONSENT: "no" })).toBe(true);
    expect(requireExpressConsent({ SMS_REQUIRE_EXPRESS_CONSENT: "0" })).toBe(true);
    expect(requireExpressConsent({ SMS_REQUIRE_EXPRESS_CONSENT: "FALSE" })).toBe(true);

    // Exactly one spelling relaxes it, and it has to be deliberate.
    expect(requireExpressConsent({ SMS_REQUIRE_EXPRESS_CONSENT: "false" })).toBe(false);
  });
});

/**
 * ── THE WIRING, NOT JUST THE RULE ───────────────────────────────────────
 *
 * Three rules in this repo were correct and unreachable, so a rule without a
 * caller is tested as its own failure. This asserts the CALL in enrol-core,
 * not the import — `src.indexOf("getSalesforceClient")` once matched an import
 * at the top of a file and proved nothing.
 */
describe("the consent check is actually wired into enrolment", () => {
  const src = readFileSync("lib/messaging/enrol-core.ts", "utf8");
  // Comments mention these names for good reasons; strip them before asserting.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("calls readSmsConsent and mayEnrol, and refuses on the result", () => {
    expect(code).toMatch(/readSmsConsent\(input\.record\)/);
    expect(code).toMatch(/mayEnrol\(\s*consent\s*,/);
    expect(code).toMatch(/requireExpress:\s*requireExpressConsent\(\)/);
    expect(code).toMatch(/if\s*\(!allowed\.ok\)\s*return\s*\{\s*ok:\s*false/);
  });

  it("records the consent it read onto the conversation row", () => {
    expect(code).toMatch(/sms_consent_value:\s*consent\.value/);
    expect(code).toMatch(/sms_consent_seen_at:/);
  });

  /**
   * Order matters and is cheap to lose. The refusal must come BEFORE the
   * workflow lookup, or a lead we may not text still costs three queries —
   * and, worse, a future edit could start acting on the workflow decision
   * before the consent one.
   */
  it("refuses before any workflow or step lookup happens", () => {
    /**
     * Scoped to the body of enrolLeadWith, not the whole file.
     *
     * The first version of this searched `code` and failed: publishedSteps is
     * DEFINED in this file above enrolLeadWith, so indexOf found the
     * definition rather than the call, and the test compared a position
     * inside one function to a position inside another. Same mistake as
     * matching an import and calling it a call site.
     */
    const start = code.indexOf("export async function enrolLeadWith");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start);

    const consentAt = body.indexOf("mayEnrol(");
    const workflowAt = body.indexOf("chooseWorkflow(");
    const stepsAt = body.indexOf("publishedSteps(");
    expect(consentAt).toBeGreaterThan(-1);
    expect(workflowAt).toBeGreaterThan(-1);
    expect(stepsAt).toBeGreaterThan(-1);
    expect(consentAt).toBeLessThan(workflowAt);
    expect(consentAt).toBeLessThan(stepsAt);
  });
});

/**
 * ── AND THE BEHAVIOUR, NOT ONLY THE WIRING ──────────────────────────────
 *
 * The suite passed the moment this gate was added, which was the warning
 * sign: nothing in vitest exercised enrolLeadWith at all. Its only real
 * coverage was `npm run verify:enrol`, which is not in gates and writes to
 * production, so the default-ON gate could have been inert and every test
 * would still have been green.
 *
 * This stub answers the two questions that matter — does it refuse, and does
 * it refuse EARLY — by recording which tables were read.
 */
describe("enrolLeadWith refuses on consent, before it reads anything else", () => {
  const WS = { id: "ws-1", name: "NY Queens Leads", time_zone: "America/New_York", is_active: true };

  function stub(workspace: Record<string, unknown> | null) {
    const touched: string[] = [];
    const client = {
      from: (table: string) => {
        touched.push(table);
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order", "limit", "range", "neq", "is"]) {
          chain[m] = () => chain;
        }
        const result = () => (table === "sms_sub_accounts"
          ? { data: workspace, error: null }
          : { data: [], error: null });
        chain.maybeSingle = () => Promise.resolve(result());
        chain.single = () => Promise.resolve(result());
        chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
        return chain;
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;
    return { client, touched };
  }

  const enrol = async (record: Record<string, unknown>, workspace = WS) => {
    const { enrolLeadWith } = await import("@/lib/messaging/enrol-core");
    const { client, touched } = stub(workspace);
    const res = await enrolLeadWith(client, {
      workspaceId: "ws-1",
      // toE164 rejects 999 and the 555 exchange, so a number that survives
      // validation — otherwise every case here returns "not a usable phone
      // number" and the consent gate is never reached, which is exactly how
      // the first version of this test passed nothing and proved nothing.
      customerPhone: "+19175551234",
      record: record as never,
      now: new Date("2026-10-11T15:00:00Z"),
    });
    return { res, touched };
  };

  it("refuses an opted-out lead and never looks up a workflow", async () => {
    const { res, touched } = await enrol({ Id: "00Q1", SMS_Opt_In__c: "Opt-Out" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/opted out/i);
    expect(touched).toContain("sms_sub_accounts");
    expect(touched).not.toContain("sms_workflows");
  });

  it("refuses a lead with no recorded consent, by default", async () => {
    const { res, touched } = await enrol({ Id: "00Q2" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/no SMS consent is recorded/);
    expect(touched).not.toContain("sms_workflows");
  });

  /**
   * The control. With express consent the lead gets PAST the gate and fails
   * later for an unrelated reason — which is how we know the gate is the
   * thing refusing above, and not something else swallowing every lead.
   */
  it("lets an opted-in lead through to the workflow lookup", async () => {
    const { res, touched } = await enrol({ Id: "00Q3", SMS_Opt_In__c: "Opt-In (Verified)" });
    expect(res.ok).toBe(false); // the stub has no workflows
    expect(res.ok === false && res.reason).not.toMatch(/consent|opted out/i);
    expect(touched).toContain("sms_workflows");
  });

  it("still refuses an opt-out even with the policy relaxed", async () => {
    vi.stubEnv("SMS_REQUIRE_EXPRESS_CONSENT", "false");
    try {
      const noConsent = await enrol({ Id: "00Q4" });
      // Relaxed: an unknown-consent lead now gets through to the workflow read.
      expect(noConsent.touched).toContain("sms_workflows");

      const optedOut = await enrol({ Id: "00Q5", SMS_Opt_In__c: "Opt-Out" });
      expect(optedOut.res.ok).toBe(false);
      expect(optedOut.res.ok === false && optedOut.res.reason).toMatch(/opted out/i);
      expect(optedOut.touched).not.toContain("sms_workflows");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
