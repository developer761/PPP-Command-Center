import "server-only";

/**
 * Slack for the things the TEAM should see happen.
 *
 * Karan 2026-08-24: *"can we make a slack channel for notifications like
 * approvals and all notifications and stuff?"*
 *
 * Deliberately separate from `reportError`/`reportWarn` in lib/observability,
 * which page COMMERCIAL_INCIDENT_SLACK_WEBHOOK. That channel means something is
 * BROKEN — a cron failed, a webhook signature mismatched, a send didn't. Mixing
 * "Stephanie sent a proposal" into it would train everyone to ignore the one
 * channel that only ever fires when something is wrong.
 *
 * Three rules keep this from becoming noise nobody reads:
 *
 * 1. ONE MESSAGE PER EVENT, NOT PER RECIPIENT. Bell rows and emails fan out to
 *    every approver; Slack is a room those people are already in. Posting per
 *    recipient would put the same line in three times for three approvers. So
 *    callers post AFTER their fan-out loop, once.
 *
 * 2. OPT-IN. With COMMERCIAL_SLACK_WEBHOOK unset this is a no-op, so nothing
 *    changes until somebody deliberately wires a channel.
 *
 * 3. NEVER THROWS. A proposal send does not fail because Slack is down. Every
 *    path here swallows and logs.
 */

export type SlackEvent = {
  /** One line, the way a person would say it. Slack mrkdwn. */
  text: string;
  /** Context line under it — amounts, who, which job. */
  context?: string | null;
  /** Deep link into the platform. Relative paths get the app URL prepended. */
  url?: string | null;
  /** Button label. Defaults to "Open". */
  urlLabel?: string;
  /** Left colour bar: what kind of moment this is. */
  tone?: "needs_action" | "good" | "bad" | "neutral";
};

const TONE_COLOR: Record<NonNullable<SlackEvent["tone"]>, string> = {
  // PPP brand: orange = somebody has to do something, green = it happened and
  // is good, blue = it happened, rose = it happened and is not good.
  needs_action: "#EE662E",
  good: "#8DC442",
  bad: "#E5484D",
  neutral: "#2BAAE1",
};

export function commercialSlackConfigured(): boolean {
  return !!process.env.COMMERCIAL_SLACK_WEBHOOK?.trim();
}

/** Escape Slack mrkdwn control characters in interpolated user text. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function absolute(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  return `${base}${url}`;
}

export async function postCommercialSlack(event: SlackEvent): Promise<void> {
  const webhook = process.env.COMMERCIAL_SLACK_WEBHOOK?.trim();
  if (!webhook) return;

  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: event.text } },
  ];
  if (event.context?.trim()) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: event.context }] });
  }
  // A button needs a real absolute URL. Without NEXT_PUBLIC_APP_URL a relative
  // path would render as a dead link, so the button is dropped rather than
  // shown broken — the message still says what happened.
  const href = event.url ? absolute(event.url) : null;
  if (href && /^https?:\/\//i.test(href)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: event.urlLabel ?? "Open", emoji: false },
          url: href,
        },
      ],
    });
  }

  const payload = {
    // `text` is the phone banner — Slack shows it before the blocks render, so
    // it has to stand alone. Strip mrkdwn so it doesn't read as punctuation.
    text: event.text.replace(/[*_`]/g, ""),
    attachments: [{ color: TONE_COLOR[event.tone ?? "neutral"], blocks }],
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // The caller is in a serverless function with a finite budget, and this
      // is the least important thing it is doing.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.warn(`[commercial-slack] post returned ${res.status}`);
  } catch (err) {
    console.warn(
      `[commercial-slack] post failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
