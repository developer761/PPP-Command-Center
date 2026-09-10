import { describe, it, expect } from "vitest";
import { fillMergeFields, unresolvedFields, hasUnresolved } from "@/lib/messaging/merge-fields";
import { gatedSend } from "@/lib/messaging/gate";
import { LoggingTransport } from "@/lib/messaging/transport";
import { classifyRefusal } from "@/lib/messaging/scheduler";
import type { E164 } from "@/lib/messaging/phone";

const OPENER =
  "Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! " +
  "Call us at {{workspace_phone}} with any questions. Reply END to stop texts.";

describe("filling in a campaign message", () => {
  it("puts the workspace's own number in, readably", () => {
    const out = fillMergeFields(OPENER, { workspacePhone: "+15163448418" });
    expect(out).toContain("516-344-8418");
    expect(out).not.toContain("{{");
  });

  /** A Nassau customer must not be told to ring the Queens office. */
  it("gives different workspaces different numbers", () => {
    const nassau = fillMergeFields(OPENER, { workspacePhone: "+15163448418" });
    const queens = fillMergeFields(OPENER, { workspacePhone: "+13476577035" });
    expect(nassau).not.toBe(queens);
  });

  it("uses a first name, not the whole one", () => {
    // "Hi Jeremy Saxe" reads like a form letter.
    expect(fillMergeFields("Hi {{customer_name}}", { customerName: "Jeremy Saxe" })).toBe("Hi Jeremy");
  });

  /**
   * Left in place, not blanked. "Call us at  with any questions" looks like a
   * typo and would not be noticed; the placeholder is loud and gets refused.
   */
  it("leaves a placeholder it cannot fill", () => {
    const out = fillMergeFields(OPENER, {});
    expect(out).toContain("{{workspace_phone}}");
    expect(unresolvedFields(out)).toEqual(["workspace_phone"]);
  });

  it("leaves a field nobody has ever defined", () => {
    expect(unresolvedFields(fillMergeFields("Hi {{nonsense}}", {}))).toEqual(["nonsense"]);
  });

  it("tolerates the spacing somebody might type", () => {
    expect(fillMergeFields("at {{ workspace_phone }}", { workspacePhone: "+15163448418" }))
      .toBe("at 516-344-8418");
  });

  it("says nothing is outstanding once everything is filled", () => {
    expect(hasUnresolved(fillMergeFields(OPENER, { workspacePhone: "+15163448418" }))).toBe(false);
  });

  it("leaves an ordinary message alone", () => {
    expect(fillMergeFields("What's the address?", {})).toBe("What's the address?");
  });
});

describe("the gate refuses a message with a blank left in it", () => {
  const ws = {
    id: "w", name: "NY LI Nassau Leads", phone_e164: "+15163448418" as E164,
    time_zone: "America/New_York", quiet_hours_start: 0, quiet_hours_end: 24,
    send_on_weekends: true,
  };
  const deps = { isSuppressed: async () => false, sentToday: async () => 0, hasEverSent: async () => true };

  /**
   * The first message of every conversation carried this placeholder and
   * nothing substituted it. A customer would have received "Call us at
   * {{workspace_phone}}" as the first thing PPP ever sent them.
   */
  it("does not send an unfilled opener", async () => {
    const t = new LoggingTransport();
    const res = await gatedSend(
      { workspace: ws, to: "+15165551234" as E164, body: OPENER, agent: "campaign" },
      { ...deps, transport: t }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unresolved_merge_field");
    expect(t.sent).toHaveLength(0);
  });

  it("sends the same message once it is filled", async () => {
    const t = new LoggingTransport();
    const res = await gatedSend(
      {
        workspace: ws, to: "+15165551234" as E164,
        body: fillMergeFields(OPENER, { workspacePhone: ws.phone_e164 }),
        agent: "campaign",
      },
      { ...deps, transport: t }
    );
    expect(res.ok).toBe(true);
    expect(t.sent[0].body).toContain("516-344-8418");
  });

  /** Retrying cannot invent a value nobody defined. */
  it("is a failure to surface, not something to retry", () => {
    expect(classifyRefusal({ ok: false, reason: "unresolved_merge_field" })).toBe("fail");
  });
});
