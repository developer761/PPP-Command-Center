import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAlertText, buildSlackPayload } from "@/lib/alerts/materials-alerts";

describe("what an alert says (Kate R6.1)", () => {
  const alert = {
    kind: "color_form_bounced" as const,
    summary: "The customer never received the colour form.",
    workOrder: "00306643",
    detail: { Customer: "M. Whitfield", "Sent to": "m@example.com", Empty: null },
  };

  it("names the job, because an alert nobody can act on becomes noise", () => {
    const t = buildAlertText(alert);
    expect(t).toContain("00306643");
    expect(t).toContain("M. Whitfield");
    expect(t).toContain("m@example.com");
  });

  it("always says what to do about it", () => {
    // A failure notice with no next step gets read once and ignored after.
    expect(buildAlertText(alert)).toMatch(/What to do:/);
    expect(buildAlertText(alert).toLowerCase()).toContain("re-send");
  });

  it("drops empty detail rather than printing blanks", () => {
    expect(buildAlertText(alert)).not.toContain("Empty");
  });

  it("distinguishes the two bounces, which need different responses", () => {
    const order = buildAlertText({ kind: "supplier_order_bounced", summary: "x" });
    const form = buildAlertText({ kind: "color_form_bounced", summary: "x" });
    expect(order).toContain("vendor");
    expect(form).toContain("waiting on colours");
    expect(order).not.toBe(form);
  });

  it("builds a Slack payload Slack will accept", () => {
    const p = buildSlackPayload(alert) as { text: string; blocks: Array<Record<string, unknown>> };
    // `text` is the notification preview and the fallback for clients that
    // cannot render blocks — without it the alert arrives blank on a watch.
    expect(typeof p.text).toBe("string");
    expect(p.text.length).toBeGreaterThan(0);
    expect(Array.isArray(p.blocks)).toBe(true);
    const section = p.blocks.find((b) => Array.isArray((b as { fields?: unknown[] }).fields)) as
      | { fields: unknown[] } | undefined;
    // Slack rejects a section carrying more than 10 fields outright.
    if (section) expect(section.fields.length).toBeLessThanOrEqual(10);
  });

  it("never exceeds Slack's field cap even with a lot of detail", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, `v${i}`]));
    const p = buildSlackPayload({ kind: "unexpected_error", summary: "s", workOrder: "WO", detail: many }) as
      { blocks: Array<{ fields?: unknown[] }> };
    const section = p.blocks.find((b) => Array.isArray(b.fields));
    expect(section!.fields!.length).toBeLessThanOrEqual(10);
  });
});

describe("delivering the alert, and what happens when that fails", () => {
  const sendEmail = vi.fn();
  const recipients = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    sendEmail.mockReset().mockResolvedValue({ ok: true });
    recipients.mockReset().mockReturnValue(["ops@precisionpaintingplus.net"]);
    vi.doMock("@/lib/email/resend", () => ({ sendEmail }));
    vi.doMock("@/lib/customer-form/sf-failure-alert", () => ({ opsAlertRecipients: recipients }));
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.PPP_MATERIALS_SLACK_WEBHOOK; });

  const load = async () => (await import("@/lib/alerts/materials-alerts")).alertMaterialsFailure;
  const A = { kind: "supplier_order_send_failed" as const, summary: "s", workOrder: "WO-1" };

  it("posts to Slack when the webhook is configured", async () => {
    process.env.PPP_MATERIALS_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 });
    await (await load())(A);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("emails instead when no webhook is set — so nothing is lost on day one", async () => {
    await (await load())(A);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toContain("WO-1");
  });

  it("emails when Slack answers with an error", async () => {
    process.env.PPP_MATERIALS_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500 });
    await (await load())(A);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("emails when Slack throws outright", async () => {
    process.env.PPP_MATERIALS_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    await (await load())(A);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("shouts when BOTH channels fail — Kate asked about exactly this", async () => {
    // "And if the alert itself fails to send, nothing tells us."
    process.env.PPP_MATERIALS_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    sendEmail.mockRejectedValue(new Error("resend down"));
    const spy = vi.spyOn(console, "error");
    await (await load())(A);
    const shouted = spy.mock.calls.some((c) => String(c[0]).includes("UNDELIVERED"));
    expect(shouted, "an undeliverable alert must still be findable in the logs").toBe(true);
  });

  it("never throws, whatever goes wrong", async () => {
    // It is called from catch blocks. If reporting a failure can fail the
    // request, a bad webhook takes down the flows it was added to watch.
    process.env.PPP_MATERIALS_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("x"));
    sendEmail.mockRejectedValue(new Error("y"));
    recipients.mockImplementation(() => { throw new Error("config blew up"); });
    await expect((await load())(A)).resolves.toBeUndefined();
  });

  it("collapses a retry storm but keeps reporting distinct failures", async () => {
    process.env.PPP_MATERIALS_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 });
    const alertFn = await load();
    await alertFn(A); await alertFn(A); await alertFn(A);
    expect(globalThis.fetch, "identical alerts inside a minute").toHaveBeenCalledTimes(1);
    await alertFn({ ...A, workOrder: "WO-2" });
    expect(globalThis.fetch, "a different job is a different failure").toHaveBeenCalledTimes(2);
  });
});
