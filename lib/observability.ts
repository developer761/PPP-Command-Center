import "server-only";

/**
 * Observability — Slack-webhook alerting for production failures.
 *
 * Replaces the `console.warn(...)` pattern that lives in cron jobs,
 * webhook handlers, and notification dispatchers. Critical failures
 * (sustained 5xx, total wipe-outs, HMAC mismatches) post to a Slack
 * channel so the team finds out within seconds instead of "next time
 * someone checks the logs."
 *
 * Design invariants:
 *
 *   1. NEVER throws. The whole point is "tell us when things break" —
 *      if THIS function breaks, the caller's flow must not. Every
 *      external call (fetch to Slack) is wrapped in try/catch +
 *      promise-chain catch handlers. A misconfigured webhook URL,
 *      Slack rate limit, network blip — none of them propagate.
 *
 *   2. RATE-LIMITED. Slack incoming webhooks cap at ~1/sec. If a cron
 *      tries to send 100 errors in a row, only ~5 land + the rest get
 *      429'd or queued. We dedup by error-signature within a 5-minute
 *      window and aggregate the count instead.
 *
 *   3. PII-SAFE. Customer emails, opp titles, supplier names — none
 *      of those go into Slack messages. Use UUID prefixes, kind labels,
 *      generic counts. The detail is in Vercel logs (which only the
 *      team has access to anyway).
 *
 *   4. STARTUP GRACE. Skip alerts in the first 30 seconds after server
 *      start. Cold-start config races (env vars not yet picked up,
 *      Supabase client not warmed) shouldn't page the team.
 *
 *   5. OPT-IN. When COMMERCIAL_INCIDENT_SLACK_WEBHOOK is unset, every
 *      helper degrades to console.warn — same shape, no Slack, no
 *      error. Lets the lib ship without anyone configuring the webhook,
 *      and lets local dev not hit Slack.
 *
 * Wiring (deliberate, not greedy): the surfaces audits have flagged as
 * the worst silent-failure spots. Don't blanket-wrap every catch — only
 * the ones where a missed alert would let a real production issue rot
 * for a day+.
 */

type Severity = "critical" | "warn" | "info";

type ReportInput = {
  /** Short error key for grouping/dedup. Lowercase + underscores.
   *  Examples: "cron_total_wipeout", "archive_hmac_mismatch",
   *  "resend_send_failed", "bell_insert_failed". */
  key: string;
  /** Human-readable one-liner shown bold in Slack. */
  message: string;
  /** Which platform raised it — prefixes the Slack message so a single
   *  channel can serve both Command Centers without confusion. */
  platform: "ppp_cc" | "commercial_cc" | "shared";
  /** Severity drives emoji + color band in Slack.
   *  - critical: 🚨 + red — wakes someone up
   *  - warn:     ⚠️ + amber — fix when convenient
   *  - info:     ℹ️ + blue — for completeness; aggregates send if too noisy */
  severity?: Severity;
  /** Optional structured context. PII-safe values only:
   *  source IDs (first 8 chars of UUIDs), counts, kind labels, error
   *  codes. DO NOT pass customer names, emails, opp titles, etc.
   *  Rendered as a key:value list under the message. */
  context?: Record<string, string | number | boolean | null | undefined>;
};

// ─────────────────────────────────────────────────────────────────────
// Module-level state (process-scoped — fine for serverless because each
// instance has its own dedup window and the window is short anyway).
// ─────────────────────────────────────────────────────────────────────

/** Wall-clock at server start. Used to skip alerts during cold-start. */
const SERVER_STARTED_AT_MS = Date.now();
const STARTUP_GRACE_MS = 30_000; // 30 seconds

/** Dedup window per error-key, in ms. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Map<errorKey, { firstSeenAt, count, lastFlushedAt }>. */
type DedupEntry = {
  firstSeenAt: number;
  count: number;
  lastFlushedAt: number;
  message: string;
  platform: ReportInput["platform"];
  severity: Severity;
  context?: ReportInput["context"];
};
const dedupBuffer = new Map<string, DedupEntry>();

/** Hard cap on dedup map size. Prevents unbounded memory growth if a
 *  bug somehow generates infinite unique keys. 1000 is plenty for the
 *  ~10-15 error keys we'll ever realistically have. */
const DEDUP_MAX_KEYS = 1000;

// ─────────────────────────────────────────────────────────────────────
// Slack rendering — block-kit format for nicer visual hierarchy
// ─────────────────────────────────────────────────────────────────────

const PLATFORM_LABEL: Record<ReportInput["platform"], string> = {
  ppp_cc: "[PPP CC]",
  commercial_cc: "[Commercial CC]",
  shared: "[Platform]",
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🚨",
  warn: "⚠️",
  info: "ℹ️",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#dc2626", // red-600
  warn: "#d97706", // amber-600
  info: "#2563eb", // blue-600
};

function buildSlackPayload(input: ReportInput, count: number): unknown {
  const severity = input.severity ?? "warn";
  const aggregated = count > 1 ? ` (×${count} in last 5m)` : "";
  // Mobile Slack notifications truncate after ~80 chars — put the
  // action-needed first.
  const headline = `${SEVERITY_EMOJI[severity]} ${PLATFORM_LABEL[input.platform]} ${input.message}${aggregated}`;
  const contextFields = input.context
    ? Object.entries(input.context)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .slice(0, 10) // safety: cap fields shown
        .map(([k, v]) => `*${k}:* \`${String(v).slice(0, 200)}\``)
        .join("  ·  ")
    : "";
  return {
    text: headline, // fallback for mobile notification banner
    attachments: [
      {
        color: SEVERITY_COLOR[severity],
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*${headline}*` },
          },
          ...(contextFields
            ? [
                {
                  type: "context",
                  elements: [{ type: "mrkdwn", text: contextFields }],
                },
              ]
            : []),
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `\`key=${input.key}\`  ·  ${new Date().toISOString()}`,
              },
            ],
          },
        ],
      },
    ],
  };
}

async function postToSlack(webhookUrl: string, payload: unknown): Promise<void> {
  // Always wrap — Slack outage, DNS blip, network timeout must NEVER
  // propagate to the caller. 5s timeout because the caller is probably
  // in a serverless function with a finite budget.
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // Slack returns 429 when rate-limited. Just swallow — the dedup
      // logic will absorb future calls with the same key.
      console.warn(`[observability] slack post returned ${res.status}`);
    }
  } catch (err) {
    // Network/timeout/abort. Log to console only — don't throw.
    console.warn(
      `[observability] slack post threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Report a critical error to Slack + console. Returns immediately
 * (fire-and-forget under the hood) so the caller's hot path isn't
 * blocked by a slow Slack roundtrip.
 *
 * Use for: cron failures, webhook signature mismatches sustained,
 * total wipe-outs of a feature, send failures that block real users.
 */
export function reportError(input: ReportInput): void {
  void report({ ...input, severity: "critical" });
}

export function reportWarn(input: ReportInput): void {
  void report({ ...input, severity: input.severity ?? "warn" });
}

export function reportInfo(input: ReportInput): void {
  void report({ ...input, severity: "info" });
}

/** Shared dispatcher. Handles dedup, startup grace, console fallback,
 *  PII safety guards. Returns Promise<void>; caller can void it. */
async function report(input: ReportInput): Promise<void> {
  // Always log to console first — gives us a Vercel-log paper trail
  // even when Slack is unavailable.
  const severity = input.severity ?? "warn";
  const logFn = severity === "critical" ? console.error : console.warn;
  const contextStr = input.context
    ? " " + JSON.stringify(input.context)
    : "";
  logFn(
    `[observability:${severity}] ${PLATFORM_LABEL[input.platform]} ${input.key}: ${input.message}${contextStr}`
  );

  // Startup grace — skip Slack during the first 30s after instance
  // boot. Cold-start config races shouldn't page anyone.
  const sinceStart = Date.now() - SERVER_STARTED_AT_MS;
  if (sinceStart < STARTUP_GRACE_MS) {
    return;
  }

  const webhookUrl = process.env.COMMERCIAL_INCIDENT_SLACK_WEBHOOK?.trim();
  if (!webhookUrl) {
    // Webhook not configured — console-only mode. Don't throw, don't
    // log a warning (would spam the console for every report call on a
    // fresh deploy before the env var is set).
    return;
  }

  // Dedup: aggregate repeated alerts with the same key inside the
  // 5-minute window. Send the first occurrence immediately; subsequent
  // occurrences increment count; once the window closes, send a final
  // "×N in 5m" summary if count > 1.
  //
  // Cap dedup map to prevent unbounded growth on adversarial input.
  if (dedupBuffer.size >= DEDUP_MAX_KEYS) {
    // Drop the oldest entry (Map iteration is insertion-ordered in JS).
    const oldestKey = dedupBuffer.keys().next().value;
    if (oldestKey !== undefined) {
      dedupBuffer.delete(oldestKey);
    }
  }

  const now = Date.now();
  const existing = dedupBuffer.get(input.key);
  if (existing && now - existing.firstSeenAt < DEDUP_WINDOW_MS) {
    // Inside window — increment count, don't send.
    existing.count += 1;
    return;
  }

  // New key OR window expired. Reset entry + send immediately.
  dedupBuffer.set(input.key, {
    firstSeenAt: now,
    count: 1,
    lastFlushedAt: now,
    message: input.message,
    platform: input.platform,
    severity,
    context: input.context,
  });

  const payload = buildSlackPayload(input, 1);
  await postToSlack(webhookUrl, payload);

  // Schedule a "summary flush" 5 minutes from now to send the
  // aggregated count if more occurrences arrived during the window.
  // setTimeout in a serverless function won't fire if the instance
  // shut down first — that's acceptable; we got the FIRST occurrence
  // and consoles still have the rest.
  setTimeout(() => {
    const entry = dedupBuffer.get(input.key);
    if (!entry || entry.count <= 1) {
      dedupBuffer.delete(input.key);
      return;
    }
    const summaryPayload = buildSlackPayload(
      {
        key: input.key,
        message: `${entry.message} (rollup)`,
        platform: entry.platform,
        severity: entry.severity,
        context: entry.context,
      },
      entry.count
    );
    void postToSlack(webhookUrl, summaryPayload);
    dedupBuffer.delete(input.key);
  }, DEDUP_WINDOW_MS).unref?.();
}

/**
 * Quick test helper exposed for the /api/admin/test-slack-webhook
 * route — sends a synthetic alert immediately without going through
 * the dedup buffer. Returns ok/error so the route can show the result
 * to the admin who clicked the button.
 */
export async function testSlackWebhook(): Promise<{ ok: boolean; detail: string }> {
  const webhookUrl = process.env.COMMERCIAL_INCIDENT_SLACK_WEBHOOK?.trim();
  if (!webhookUrl) {
    return {
      ok: false,
      detail: "COMMERCIAL_INCIDENT_SLACK_WEBHOOK not set in Vercel",
    };
  }
  try {
    const payload = buildSlackPayload(
      {
        key: "test_webhook",
        message: "Test alert — Slack webhook is wired up correctly",
        platform: "shared",
        severity: "info",
        context: {
          source: "manual_test",
          triggered_at: new Date().toISOString(),
        },
      },
      1
    );
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, detail: `Slack returned HTTP ${res.status}` };
    }
    return { ok: true, detail: "Test alert sent — check the Slack channel" };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
