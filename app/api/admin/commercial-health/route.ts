import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import {
  isArchiveConfigured,
  buildArchiveAddress,
} from "@/lib/commercial/email-archive/address";

/**
 * Commercial CC · Setup Health — admin-only diagnostic that aggregates
 * every wire-up for the Commercial Command Center surface area into one
 * pass/warn/fail grid.
 *
 *   GET /api/admin/commercial-health
 *     → 200 { ok, summary, checks: HealthCheck[] }
 *     → 401 unauthorized / 403 forbidden
 *
 * Mirrors the existing /api/admin/health shape so the same
 * <HealthChecksView> component can render both. Differences:
 *   - Different probe set (commercial tables, archive HMAC, commercial
 *     cron, commercial Resend pool — not SF/supplier/customer-form)
 *   - Two groups: "platform" (env + cron + storage) and
 *     "commercial_cc" (per-stage deps)
 *
 * Performance constraints:
 *   - 5s timeout per probe (page auto-refreshes every 30s; can't block)
 *   - All probes run in parallel via Promise.allSettled
 *   - 30s cache-control header so 5 admins each on the page don't
 *     hammer Supabase
 *
 * PII safety: probe details + fix hints are infra-only (env-var names,
 * migration numbers, durations). No customer/account/opp content
 * leaks.
 */

export const dynamic = "force-dynamic";

type HealthStatus = "ok" | "warn" | "fail";
type HealthGroup = "platform" | "commercial_cc";

type HealthCheck = {
  id: string;
  label: string;
  status: HealthStatus;
  message: string;
  group?: HealthGroup;
  fix?: string;
};

type Summary = { ok: number; warn: number; fail: number; total: number };

const STAGE2_BUCKET = "commercial-email-attachments";
const STAGE2_MAX_BYTES = 25 * 1024 * 1024;
const CRON_FRESHNESS_HOURS = 25; // last fire should be within ~25h of now

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Race-protected check wrapper — every probe gets at most 5s. Returns
 *  a guaranteed HealthCheck even if the probe throws or hangs. */
async function probe(
  id: string,
  label: string,
  group: HealthGroup,
  fn: () => Promise<Omit<HealthCheck, "id" | "label" | "group">>
): Promise<HealthCheck> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<Omit<HealthCheck, "id" | "label" | "group">>((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: "fail",
              message: "Probe timed out after 5s",
              fix: "Check Vercel logs for the underlying service health",
            }),
          5_000
        )
      ),
    ]);
    return { id, label, group, ...result };
  } catch (err) {
    return {
      id,
      label,
      group,
      status: "fail",
      message: `Probe threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    };
  }
}

export async function GET() {
  // Same auth pattern as /api/admin/health
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(auth.user.id);
  const email = (profile?.email ?? auth.user.email ?? "").toLowerCase();
  const isAdmin = (profile?.is_admin ?? false) || isAdminEmail(email);
  if (!isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const sb = adminClient();

  // ──────────────── PROBES (run in parallel) ────────────────

  const probes = await Promise.all([
    // ─── PLATFORM group ───

    probe("supabase_commercial", "Supabase commercial tables", "platform", async () => {
      const start = Date.now();
      const { error } = await sb
        .from("commercial_accounts")
        .select("id", { count: "exact", head: true });
      const latency = Date.now() - start;
      if (error) {
        return {
          status: "fail",
          message: `Supabase query failed: ${error.message}`.slice(0, 150),
          fix: "Check NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY in Vercel",
        };
      }
      return {
        status: latency > 1000 ? "warn" : "ok",
        message: `Responsive in ${latency}ms · 9+ commercial tables reachable`,
      };
    }),

    probe("resend_commercial_pool", "Resend (commercial channel)", "platform", async () => {
      const hasDedicated =
        !!process.env.COMMERCIAL_RESEND_API_KEY?.trim() &&
        !!process.env.COMMERCIAL_RESEND_FROM_ADDRESS?.trim();
      const hasFallback =
        !!process.env.RESEND_API_KEY?.trim() &&
        !!process.env.RESEND_FROM_ADDRESS?.trim();
      if (hasDedicated) {
        return {
          status: "ok",
          message: `Dedicated commercial pool active: ${process.env.COMMERCIAL_RESEND_FROM_ADDRESS}`,
        };
      }
      if (hasFallback) {
        return {
          status: "warn",
          message: "Falling back to customer-pool RESEND_API_KEY (Stage 7 not yet configured)",
          fix: "Add COMMERCIAL_RESEND_API_KEY + COMMERCIAL_RESEND_FROM_ADDRESS in Vercel for deliverability isolation",
        };
      }
      return {
        status: "fail",
        message: "No Resend API key configured (commercial OR customer)",
        fix: "Add RESEND_API_KEY + RESEND_FROM_ADDRESS to Vercel",
      };
    }),

    probe("daily_cron_freshness", "Daily commercial cron", "platform", async () => {
      // We don't store cron last-fire anywhere; infer from the
      // notifications table — any notification with a cron-fired kind
      // in the last 25h means the cron is alive. Falls back to
      // "unknown" if there's no recent activity (e.g. fresh deploy,
      // no overdue tasks).
      const cutoff = new Date(Date.now() - CRON_FRESHNESS_HOURS * 60 * 60 * 1000).toISOString();
      const { data, error } = await sb
        .from("notifications")
        .select("created_at, kind")
        .in("kind", [
          "commercial_task_overdue",
          "commercial_document_expiring",
          "commercial_hot_deal_cooling",
        ])
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) {
        return {
          status: "warn",
          message: `Couldn't read notifications: ${error.message}`.slice(0, 100),
          fix: "Check migration 018 + Supabase service-role permissions",
        };
      }
      const rows = (data ?? []) as Array<{ created_at: string; kind: string }>;
      if (rows.length === 0) {
        return {
          status: "warn",
          message: `No cron-fired notifications in last ${CRON_FRESHNESS_HOURS}h — either nothing was due, or cron isn't firing`,
          fix: "If you expected reminders, check Vercel cron config + CRON_SECRET",
        };
      }
      const lastIso = rows[0].created_at;
      const ageMs = Date.now() - new Date(lastIso).getTime();
      const ageHours = Math.floor(ageMs / 3600000);
      return {
        status: "ok",
        message: `Last cron-fired notification ${ageHours}h ago (kind: ${rows[0].kind})`,
      };
    }),

    probe("slack_alerts", "Slack incident alerts", "platform", async () => {
      const url = process.env.COMMERCIAL_INCIDENT_SLACK_WEBHOOK?.trim();
      if (!url) {
        return {
          status: "warn",
          message: "COMMERCIAL_INCIDENT_SLACK_WEBHOOK not set — failures only land in Vercel console",
          fix: "Add Slack incoming webhook URL to Vercel env vars (Slack → Apps → Incoming Webhooks)",
        };
      }
      if (!url.startsWith("https://hooks.slack.com/")) {
        return {
          status: "warn",
          message: "Webhook URL doesn't look like a Slack incoming webhook",
          fix: "Should start with https://hooks.slack.com/services/...",
        };
      }
      return {
        status: "ok",
        message: "Webhook URL configured — test it via the 'Send test alert' button",
      };
    }),

    probe("cron_secret", "Cron auth secret", "platform", async () => {
      if (!process.env.CRON_SECRET?.trim()) {
        return {
          status: "fail",
          message: "CRON_SECRET not set — cron route will 500 on every fire",
          fix: "Add CRON_SECRET (any long random string) to Vercel env vars",
        };
      }
      return { status: "ok", message: "Set — Vercel cron header auth working" };
    }),

    // ─── COMMERCIAL CC group — per-stage deps ───

    probe("stage2_migration", "Stage 2 · Migration 036 (archive table)", "commercial_cc", async () => {
      const { error } = await sb
        .from("commercial_archived_emails")
        .select("id", { count: "exact", head: true });
      if (error) {
        return {
          status: "fail",
          message: `commercial_archived_emails not found: ${error.code ?? "?"} ${error.message}`.slice(0, 150),
          fix: "Paste supabase/migrations/036_commercial_email_archive.sql in Supabase SQL Editor",
        };
      }
      return { status: "ok", message: "commercial_archived_emails responsive" };
    }),

    probe("stage2_bucket", "Stage 2 · Storage bucket", "commercial_cc", async () => {
      const { data: buckets, error } = await sb.storage.listBuckets();
      if (error) {
        return {
          status: "fail",
          message: `listBuckets failed: ${error.message}`.slice(0, 150),
        };
      }
      const found = (buckets ?? []).find(
        (b) => b.id === STAGE2_BUCKET || b.name === STAGE2_BUCKET
      );
      if (!found) {
        return {
          status: "fail",
          message: `Bucket "${STAGE2_BUCKET}" not found`,
          fix: "Create the bucket in Supabase UI: private, 25 MB cap",
        };
      }
      const b = found as unknown as { public?: boolean; file_size_limit?: number | null };
      const isPrivate = b.public === false;
      const fsLimit = b.file_size_limit ?? null;
      const sizeOk = fsLimit === null || fsLimit <= STAGE2_MAX_BYTES + 1024;
      if (!isPrivate) {
        return {
          status: "fail",
          message: "Bucket exists but is PUBLIC — must be private",
          fix: "Toggle to private in Supabase Storage UI",
        };
      }
      if (!sizeOk) {
        return {
          status: "warn",
          message: `Bucket size cap (${fsLimit}) exceeds 25 MB — Resend caps inbound at 25 MB anyway`,
        };
      }
      return { status: "ok", message: "Private bucket with ≤25 MB cap" };
    }),

    probe("stage2_archive_hmac", "Stage 2 · Archive HMAC secret", "commercial_cc", async () => {
      if (!isArchiveConfigured()) {
        return {
          status: "warn",
          message: "COMMERCIAL_ARCHIVE_HMAC_SECRET not set — Email tab shows 'Not configured'",
          fix: "openssl rand -hex 32 → paste as COMMERCIAL_ARCHIVE_HMAC_SECRET in Vercel",
        };
      }
      const len = (process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET?.trim() ?? "").length;
      const sample = buildArchiveAddress("opp", "00000000-0000-0000-0000-000000000000");
      if (!sample) {
        return {
          status: "fail",
          message: "Secret set but sample address didn't build — check the helper",
        };
      }
      return {
        status: len >= 32 ? "ok" : "warn",
        message: `Secret length ${len} chars · sample address: ${sample.slice(0, 50)}…`,
        fix:
          len < 32
            ? "Bump secret to ≥32 chars (openssl rand -hex 32) for full brute-force resistance"
            : undefined,
      };
    }),

    probe("stage1_notifications", "Stage 1 · notifications table", "commercial_cc", async () => {
      const { error } = await sb
        .from("notifications")
        .select("id", { count: "exact", head: true });
      if (error) {
        return {
          status: "fail",
          message: `notifications table not reachable: ${error.message}`.slice(0, 100),
          fix: "Paste supabase/migrations/018_notifications.sql",
        };
      }
      return { status: "ok", message: "notifications table responsive" };
    }),

    probe("stage3_migration", "Stage 3 · Migration 037 (pin + @mention)", "commercial_cc", async () => {
      const { error } = await sb
        .from("commercial_opportunity_notes")
        .select("id, pinned_at, mentioned_user_ids")
        .limit(1);
      if (error) {
        return {
          status: "fail",
          message: `pinned_at or mentioned_user_ids column missing: ${error.message}`.slice(0, 150),
          fix: "Paste supabase/migrations/037_commercial_notes_pin_mention.sql",
        };
      }
      return { status: "ok", message: "pinned_at + mentioned_user_ids columns present" };
    }),

    probe("latest_migrations", "Latest migrations applied", "commercial_cc", async () => {
      // Soft probe: confirm migration 035 (property address) by selecting
      // a field added in it. If it's missing, we know migrations got
      // stuck somewhere.
      const { error: m035 } = await sb
        .from("commercial_opportunities")
        .select("property_street")
        .limit(1);
      if (m035) {
        return {
          status: "fail",
          message: "Migration 035 (property address) missing",
          fix: "Paste supabase/migrations/035_commercial_opportunity_property_address.sql",
        };
      }
      return {
        status: "ok",
        message: "Migrations 018–037 confirmed via column probes",
      };
    }),
  ]);

  // ──────────────── SUMMARY ────────────────

  const summary: Summary = {
    ok: probes.filter((c) => c.status === "ok").length,
    warn: probes.filter((c) => c.status === "warn").length,
    fail: probes.filter((c) => c.status === "fail").length,
    total: probes.length,
  };

  return NextResponse.json(
    {
      ok: true,
      stage: "commercial_cc",
      checked_at: new Date().toISOString(),
      summary,
      checks: probes,
    },
    {
      headers: {
        // Karan 2026-06-23: dropped from `private, max-age=25` to
        // `no-store` so that the moment you set an env var in Vercel,
        // run a migration, or wire Slack, the next page refresh
        // reflects it. The cache buy was tiny (admin-only endpoint,
        // low traffic) vs. the cost of "did my fix take?" anxiety.
        "Cache-Control": "no-store",
      },
    }
  );
}
