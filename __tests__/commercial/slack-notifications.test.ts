import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { postCommercialSlack, commercialSlackConfigured, slackEscape } from "@/lib/commercial/slack-notify";

/**
 * Slack for team-visible events.
 *
 * Karan 2026-08-24: *"can we make a slack channel for notifications like
 * approvals and all notifications and stuff?"*
 *
 * The two rules that decide whether a channel gets read or muted are pinned
 * here: it never posts twice for one event, and it never posts anything until
 * somebody wires a webhook.
 */

const EVENTS = readFileSync("lib/notifications/commercial-events.ts", "utf8");

afterEach(() => {
  delete process.env.COMMERCIAL_SLACK_WEBHOOK;
  vi.unstubAllGlobals();
});

describe("it is off until someone turns it on", () => {
  it("posts nothing when no webhook is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await postCommercialSlack({ text: "hello" });
    expect(fetchSpy, "posted without a webhook configured").not.toHaveBeenCalled();
    expect(commercialSlackConfigured()).toBe(false);
  });

  it("never throws, whatever Slack does", async () => {
    // A proposal send must not fail because Slack is down.
    process.env.COMMERCIAL_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(postCommercialSlack({ text: "hello" })).resolves.toBeUndefined();
  });
});

describe("the payload", () => {
  async function capture(event: Parameters<typeof postCommercialSlack>[0]) {
    process.env.COMMERCIAL_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    await postCommercialSlack(event);
    return JSON.parse(fetchSpy.mock.calls[0][1].body as string);
  }

  it("carries a plain-text fallback for the phone banner", async () => {
    // Slack shows `text` in the push banner before blocks render, so mrkdwn
    // asterisks would read as punctuation there.
    const body = await capture({ text: "*Approval needed* — R1 · $30,000.00" });
    expect(body.text).toBe("Approval needed — R1 · $30,000.00");
  });

  it("drops the button rather than rendering a dead relative link", async () => {
    // Without NEXT_PUBLIC_APP_URL a relative path cannot become a real URL. A
    // broken button is worse than no button — the message still says what
    // happened.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const body = await capture({ text: "x", url: "/commercial/opportunities/1" });
    const kinds = body.attachments[0].blocks.map((b: { type: string }) => b.type);
    expect(kinds).not.toContain("actions");
    if (appUrl) process.env.NEXT_PUBLIC_APP_URL = appUrl;
  });

  it("escapes user text so a GC name can't inject markup", () => {
    expect(slackEscape("Smith & Sons <Contracting>")).toBe("Smith &amp; Sons &lt;Contracting&gt;");
  });
});

describe("one message per EVENT, never per recipient", () => {
  /** The body of one exported event function. */
  function fn(name: string): string {
    const a = EVENTS.indexOf(`export async function ${name}(`);
    expect(a, `${name} is gone`).toBeGreaterThan(-1);
    const n = EVENTS.indexOf("\nexport async function ", a + 10);
    return EVENTS.slice(a, n === -1 ? undefined : n);
  }

  it("the approval request posts after the per-approver loop, not inside it", () => {
    const body = fn("insertCommercialProposalApprovalRequestedNotifications");
    const loop = body.indexOf("approverIds.map");
    const post = body.indexOf("postCommercialSlack");
    expect(post, "posts inside the fan-out — three approvers would get three messages")
      .toBeGreaterThan(body.indexOf("await Promise.allSettled", loop));
  });

  it("the approval decision posts only for the primary recipient", () => {
    // That function is called once per recipient, so it must gate.
    const body = fn("insertCommercialProposalApprovalDecidedNotification");
    expect(body).toContain("if (!input.forReceiver)");
  });

  it("team events post even when nobody holds a bell", () => {
    // Bells are per-person and reasonably give up with no recipients. The
    // channel is the ROOM — "a proposal went out" is as true on a deal with no
    // assignees, and gating it would make the channel silently incomplete in
    // the one case nobody would check.
    for (const name of [
      "insertCommercialProposalSentNotifications",
      "insertCommercialBidSubmittedNotifications",
      "insertCommercialInvoicePaidNotifications",
    ]) {
      const body = fn(name);
      const post = body.indexOf("postCommercialSlack");
      const gate = body.indexOf("return { fanout: 0 }");
      expect(post, `${name} is gone`).toBeGreaterThan(-1);
      expect(
        gate === -1 || post < gate,
        `${name} posts AFTER its no-recipients return, so the channel goes silent for unassigned deals`
      ).toBe(true);
    }
  });

  it("stays out of the incident channel", () => {
    // COMMERCIAL_INCIDENT_SLACK_WEBHOOK means something is BROKEN. Mixing
    // "Stephanie sent a proposal" into it trains people to ignore the one
    // channel that only fires when something is wrong.
    // Checked against the CODE, not the comments — the module's header names
    // the incident webhook to explain what it is NOT, and a blunt grep reads
    // that as a violation. (Third time this exact trap has cost a false
    // failure; strip comments first.)
    const raw = readFileSync("lib/commercial/slack-notify.ts", "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).toContain("COMMERCIAL_SLACK_WEBHOOK");
    expect(code).not.toContain("COMMERCIAL_INCIDENT_SLACK_WEBHOOK");
  });
});

describe("edge cases real data will actually produce", () => {
  async function capture(event: Parameters<typeof postCommercialSlack>[0]) {
    process.env.COMMERCIAL_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    await postCommercialSlack(event);
    return JSON.parse(fetchSpy.mock.calls[0][1].body as string);
  }

  it("omits the context block entirely when every part was null", async () => {
    // The callers build context with [a, b, c].filter(Boolean).join(" · "),
    // which yields "" when a deal has no title, no actor and no note. An empty
    // context block renders as a stray blank line in Slack.
    const body = await capture({ text: "x", context: "" });
    expect(body.attachments[0].blocks.map((b: { type: string }) => b.type)).not.toContain("context");
  });

  it("survives a GC name containing Slack markup characters", async () => {
    // "Smith & Sons <Contracting>" and names with asterisks are real. Escaped
    // text must not break the block, and the plain-text banner must not show
    // stray punctuation.
    const gc = slackEscape("Smith & Sons <Contracting> *Ltd*");
    const body = await capture({ text: `*New bid request* — *${gc}*` });
    expect(body.text).not.toContain("*");
    expect(body.attachments[0].blocks[0].text.text).toContain("&amp;");
    expect(body.attachments[0].blocks[0].text.text).toContain("&lt;Contracting&gt;");
  });

  it("renders a button once the app URL is configured", async () => {
    // Without NEXT_PUBLIC_APP_URL the button is dropped by design. With it, a
    // relative path must become a real absolute URL — otherwise every message
    // in the channel is a dead end.
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://hub.precisionpaintingplus.net";
    const body = await capture({ text: "x", url: "/commercial/proposals", urlLabel: "Review" });
    const actions = body.attachments[0].blocks.find((b: { type: string }) => b.type === "actions");
    expect(actions, "no button rendered even though the app URL is set").toBeTruthy();
    expect(actions.elements[0].url).toBe("https://hub.precisionpaintingplus.net/commercial/proposals");
    if (prev) process.env.NEXT_PUBLIC_APP_URL = prev; else delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("does not double a slash when the app URL has a trailing one", async () => {
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://hub.precisionpaintingplus.net/";
    const body = await capture({ text: "x", url: "/commercial/proposals" });
    const actions = body.attachments[0].blocks.find((b: { type: string }) => b.type === "actions");
    expect(actions.elements[0].url).not.toContain("net//");
    if (prev) process.env.NEXT_PUBLIC_APP_URL = prev; else delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("bounds how long it can hold up the caller", async () => {
    // Two callers AWAIT their notification function — including the PUBLIC bid
    // form, where a hanging Slack would add latency to a GC's submission. The
    // timeout is what keeps that bounded.
    const src = readFileSync("lib/commercial/slack-notify.ts", "utf8");
    expect(src).toContain("AbortSignal.timeout(");
  });
});
