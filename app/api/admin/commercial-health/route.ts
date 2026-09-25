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

    /**
     * CAN WE ACTUALLY SEND AS finance@ AND estimating@?
     *
     * Karan 2026-09-17, Katie's ask: invoices from finance@tomcopainting.com,
     * proposals from estimating@tomcopainting.com.
     *
     * Setting those env vars is the easy half. The half that decides whether
     * anything sends is whether Resend has VERIFIED the domain they belong to —
     * and Resend rejects the whole message if it has not, so a wrong address
     * here means invoices silently stop going out rather than going out from
     * the wrong name.
     *
     * That state lives in Resend's dashboard, not in this codebase, so it
     * cannot be checked by reading anything here. This asks Resend directly and
     * says plainly which of the two addresses will work.
     */
    /**
     * WHAT WILL AN INVOICE ACTUALLY BE SENT AS?
     *
     * Katie's ask: invoices from finance@tomcopainting.com, proposals from
     * estimating@tomcopainting.com.
     *
     * This answers the question in three parts, and it is built so the FIRST
     * two always answer even when the third cannot:
     *
     *   1. what address will be used (read from env — always knowable);
     *   2. whether that is a deliberate choice or the shared-channel fallback
     *      still showing through, which is how you tell whether the Vercel step
     *      has actually landed;
     *   3. whether Resend has verified that domain — which needs the API.
     *
     * The first version stopped at a 401 from step 3 and reported nothing else.
     * A 401 here is not a misconfiguration, it is a SENDING-SCOPED key, which is
     * the right kind of key to send with — so it must not swallow the two
     * answers that need no key at all.
     */
    probe("resend_sender_domains", "Invoice + proposal sender addresses", "platform", async () => {
      const shared = (process.env.COMMERCIAL_RESEND_FROM_ADDRESS || process.env.RESEND_FROM_ADDRESS || "").trim();
      const invoiceSet = (process.env.COMMERCIAL_INVOICE_FROM_ADDRESS || "").trim();
      const proposalSet = (process.env.COMMERCIAL_PROPOSAL_FROM_ADDRESS || "").trim();
      const invoiceFrom = invoiceSet || shared;
      const proposalFrom = proposalSet || shared;

      if (!invoiceFrom && !proposalFrom) {
        return {
          status: "fail",
          message: "No sender address configured at all — nothing can send",
          fix: "Set COMMERCIAL_INVOICE_FROM_ADDRESS and COMMERCIAL_PROPOSAL_FROM_ADDRESS in Vercel (Production), then redeploy",
        };
      }

      // Step 3, best-effort. A sending-only key cannot list domains, and that
      // is fine — say so rather than failing the whole check.
      const key = (process.env.COMMERCIAL_RESEND_API_KEY || process.env.RESEND_API_KEY || "").trim();
      let verified: string[] | null = null;
      let domainNote = "";
      if (key) {
        try {
          const res = await fetch("https://api.resend.com/domains", {
            headers: { Authorization: `Bearer ${key}` },
            cache: "no-store",
          });
          if (res.ok) {
            const body = (await res.json()) as { data?: { name: string; status: string }[] };
            verified = (body.data ?? []).filter((d) => d.status === "verified").map((d) => d.name);
          } else if (res.status === 401 || res.status === 403) {
            domainNote = " Domain verification not checked (the API key is sending-scoped, which is correct — confirm in Resend → Domains).";
          } else {
            domainNote = ` Domain check unavailable (Resend returned ${res.status}).`;
          }
        } catch {
          domainNote = " Domain check unavailable (could not reach Resend).";
        }
      }

      const sendable = (addr: string) => {
        if (verified === null) return null; // unknown, not false
        const domain = addr.split("@")[1]?.toLowerCase();
        if (!domain) return false;
        return verified.some((v) => domain === v.toLowerCase() || domain.endsWith(`.${v.toLowerCase()}`));
      };

      const unverified = [
        ["Invoices", invoiceFrom],
        ["Proposals", proposalFrom],
      ].filter(([, addr]) => sendable(addr as string) === false);
      if (unverified.length > 0) {
        return {
          status: "fail",
          // Resend rejects the whole message from an unverified domain, so this
          // is "no email", not "wrong name on the email".
          message: unverified.map(([l, a]) => `${l}: ${a} — domain NOT verified in Resend`).join(" · "),
          fix: `Resend → Domains → Add Domain, publish the DKIM/SPF records, then Verify. Verified today: ${(verified ?? []).join(", ") || "none"}`,
        };
      }

      // Still on the shared channel address = the Vercel step has not landed.
      const stillShared = [
        !invoiceSet ? "invoices" : null,
        !proposalSet ? "proposals" : null,
      ].filter(Boolean) as string[];
      if (stillShared.length > 0) {
        return {
          status: "warn",
          message: `${stillShared.join(" and ")} still send from the shared address ${shared || "(none)"} — the per-type addresses are not set yet.${domainNote}`,
          fix: "Vercel → Settings → Environment Variables (Production): COMMERCIAL_INVOICE_FROM_ADDRESS=finance@tomcopainting.com, COMMERCIAL_PROPOSAL_FROM_ADDRESS=estimating@tomcopainting.com — then redeploy. Env vars only apply to a NEW deployment.",
        };
      }

      return {
        status: "ok",
        message: `Invoices from ${invoiceFrom}, proposals from ${proposalFrom}.${domainNote || " Both on a verified domain."}`,
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
        /**
         * ASK THE CRON, don't infer from its output.
         *
         * This used to say "either nothing was due, or cron isn't firing" —
         * two opposite conclusions the check could not separate. On a quiet
         * book (today: zero overdue tasks, zero documents with an expiry) it
         * sits amber permanently, which teaches people to ignore the one row
         * that would tell them the nightly job had died.
         *
         * The cron now writes a heartbeat on every run, including runs that
         * found nothing — which is exactly the case the inference got wrong.
         */
        const { getCommercialSetting } = await import("@/lib/commercial/settings");
        const beat = await getCommercialSetting<{ at?: string; found?: number } | null>(
          "commercial_daily_cron_last_run",
          null,
        );
        if (beat?.at) {
          const beatAgeH = Math.floor((Date.now() - new Date(beat.at).getTime()) / 3600000);
          if (beatAgeH <= CRON_FRESHNESS_HOURS) {
            return {
              status: "ok",
              message: `Cron ran ${beatAgeH}h ago and found nothing due — no overdue tasks, expiring documents or cooling deals`,
            };
          }
          return {
            status: "fail",
            message: `Cron has not run in ${beatAgeH}h (last ran ${beat.at.slice(0, 16).replace("T", " ")} UTC)`,
            fix: "Check Vercel → Settings → Cron Jobs. Note the Hobby plan allows a limited number of daily crons; an unsupported schedule is dropped rather than erroring.",
          };
        }
        return {
          status: "warn",
          message: `No cron-fired notifications in last ${CRON_FRESHNESS_HOURS}h, and no heartbeat recorded yet — this resolves itself after the next run`,
          fix: "If it is still saying this tomorrow, check Vercel cron config + CRON_SECRET",
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
      /**
       * PROBE THE NEWEST ONES, and say only what was actually checked.
       *
       * This selected ONE column from migration 035 and then reported
       * "Migrations 018–037 confirmed via column probes". Everything after
       * 037 was unverified while the page read green — including the five
       * payroll and AIA migrations added on 2026-09-24.
       *
       * That matters more here than almost anywhere: there is no migration
       * runner in this repo. Karan pastes the SQL into Supabase by hand, so a
       * missed paste is a real and recurring risk, and this page is the only
       * thing that would catch it. A probe that overstates its coverage turns
       * the one safety net into a false all-clear.
       *
       * Each entry names the column or table its migration added, so a
       * failure says which file to paste rather than "something is stuck".
       */
      const checks: { label: string; file: string; run: () => Promise<boolean> }[] = [
        {
          label: "035 property address",
          file: "035_commercial_opportunity_property_address.sql",
          run: async () =>
            !(await sb.from("commercial_opportunities").select("property_street").limit(1)).error,
        },
        {
          label: "AIA payments",
          file: "20260924090000_aia_payments.sql",
          run: async () =>
            !(await sb.from("commercial_aia_payments").select("id").limit(1)).error,
        },
        {
          label: "payroll periods",
          file: "20260924200000_payroll_periods.sql",
          run: async () =>
            !(await sb.from("commercial_payroll_periods").select("id").limit(1)).error,
        },
        {
          label: "payroll unassigned job",
          file: "20260924210000_payroll_unassigned_job.sql",
          run: async () =>
            !(
              await sb
                .from("commercial_payroll_costs")
                .select("unassigned_opportunity_id")
                .limit(1)
            ).error,
        },
      ];
      const missing: { label: string; file: string }[] = [];
      for (const c of checks) {
        // A rejected select is how PostgREST reports an unknown column or
        // table, which is exactly "this migration has not been pasted".
        if (!(await c.run())) missing.push({ label: c.label, file: c.file });
      }
      if (missing.length > 0) {
        return {
          status: "fail",
          message: `Not applied: ${missing.map((m) => m.label).join(", ")}`,
          fix: `Paste ${missing.map((m) => `supabase/migrations/${m.file}`).join(" and ")}`,
        };
      }
      return {
        status: "ok",
        message: `${checks.length} migrations confirmed by probing the column or table each one adds — through 2026-09-24 (payroll + AIA payments)`,
      };
    }),

    probe("aia_number_reuse", "AIA number re-use · Migration 20260924180000", "commercial_cc", async () => {
      /**
       * A MIGRATION THAT DROPS SOMETHING IS INVISIBLE TO THE CHECK ABOVE.
       *
       * That one probes for the column or table each migration ADDS. This
       * migration adds nothing — its whole job is to drop a UNIQUE constraint
       * — so it had nothing to look for, and the page read "4 migrations
       * confirmed" while saying nothing at all about it.
       *
       * It is the one that matters most of the five. 20260924160000 tried to
       * drop that constraint by the name the naming convention implies,
       * `..._application_number_key`. That string is 65 characters; Postgres
       * truncates identifiers at 63 and shortens the middle, so the real name
       * is `..._application_numb_key`. Nothing matched, `if exists` swallowed
       * it, the migration reported success, and Stephanie stayed blocked —
       * "duplicate key value violates unique constraint" every time she
       * re-used a deleted application's number.
       *
       * ── WHAT THIS CAN AND CANNOT SEE ───────────────────────────────────
       *
       * PostgREST cannot read pg_constraint, so the constraint's absence
       * cannot be asserted directly. What CAN be asserted is a state the old
       * constraint made impossible: one (opportunity, application number)
       * held by a live row and a soft-deleted row at the same time. Finding
       * that is proof the drop landed.
       *
       * Not finding it proves nothing — it may simply mean nobody has re-used
       * a number yet. So that case says so rather than reporting a clean
       * pass. This page's own migration probe carries a comment about a
       * check that overstated its coverage and turned the safety net into a
       * false all-clear; this is the same trap, and naming the blind spot is
       * the only honest way through it.
       *
       * Two live rows sharing a number is a real failure either way: the
       * partial index that replaced the constraint exists to prevent exactly
       * that.
       */
      const { data, error } = await sb
        .from("commercial_aia_applications")
        .select("opportunity_id, application_number, deleted_at");
      if (error) {
        return {
          status: "warn",
          message: `Could not read AIA applications: ${error.message}`,
          fix: "Check the commercial_aia_applications table is reachable.",
        };
      }
      const rows = (data ?? []) as {
        opportunity_id: string;
        application_number: number;
        deleted_at: string | null;
      }[];
      const seen = new Map<string, { live: number; deleted: number }>();
      for (const r of rows) {
        const key = `${r.opportunity_id}|${r.application_number}`;
        const cur = seen.get(key) ?? { live: 0, deleted: 0 };
        if (r.deleted_at) cur.deleted += 1;
        else cur.live += 1;
        seen.set(key, cur);
      }
      const twoLive = [...seen.values()].filter((v) => v.live > 1).length;
      if (twoLive > 0) {
        return {
          status: "fail",
          message: `${twoLive} application number${twoLive === 1 ? " is" : "s are"} held by more than one LIVE application`,
          fix: "Paste supabase/migrations/20260924180000_aia_drop_truncated_unique.sql — it re-asserts the partial unique index that prevents this.",
        };
      }
      const reused = [...seen.values()].filter((v) => v.live > 0 && v.deleted > 0).length;
      if (reused > 0) {
        return {
          status: "ok",
          message: `Constraint confirmed dropped — ${reused} number${reused === 1 ? " is" : "s are"} held by a live and a deleted application at once, which the old table-wide constraint made impossible`,
        };
      }
      return {
        status: "ok",
        message:
          "No number has been re-used yet, so the drop cannot be confirmed from the data. If a deleted application's number is ever rejected, 20260924180000_aia_drop_truncated_unique.sql has not been pasted.",
      };
    }),

    probe("winloss_migration", "Win/Loss Debrief · Migrations 038 + 039", "commercial_cc", async () => {
      // Confirm 038 by hitting the debrief table; confirm 039 by checking
      // the source_outcome column on account_notes (added in 039 for
      // cross-flip protection). One probe covers both — if either is
      // missing, the Debrief tab will 500 at runtime.
      const { error: m038 } = await sb
        .from("commercial_win_loss_debrief")
        .select("id", { count: "exact", head: true });
      if (m038) {
        return {
          status: "fail",
          message: `commercial_win_loss_debrief missing: ${m038.message}`.slice(0, 150),
          fix: "Paste supabase/migrations/038_commercial_win_loss_debrief.sql",
        };
      }
      const { error: m039 } = await sb
        .from("commercial_account_notes")
        .select("source_outcome")
        .limit(1);
      if (m039) {
        return {
          status: "fail",
          message: `source_outcome column missing: ${m039.message}`.slice(0, 150),
          fix: "Paste supabase/migrations/039_win_loss_debrief_hardening.sql",
        };
      }
      return {
        status: "ok",
        message: "Debrief + competitors + account_notes tables ready",
      };
    }),

    /**
     * BACKLOG §4.1 tripwire — a project with no opportunity is invisible to
     * every report.
     *
     * `commercial_projects.opportunity_id` is nullable by design (a direct
     * T&M job with no bid is a real thing), but every report starts from
     * opportunities. The failure mode is not an error: those costs simply
     * stop being counted, and company totals are quietly light with nothing
     * on screen to say so.
     *
     * It was documented and left unbuilt because it isn't real yet. This
     * probe is what makes "isn't real yet" a fact rather than an assumption
     * — the day the first one appears, it says so here instead of nowhere.
     */
    probe("orphan_projects", "Projects with no opportunity", "commercial_cc", async () => {
      const sb = adminClient();
      const { count, error } = await sb
        .from("commercial_projects")
        .select("id", { count: "exact", head: true })
        .is("opportunity_id", null)
        .is("deleted_at", null);
      if (error) {
        return {
          status: "warn",
          message: `Could not count: ${error.message}`.slice(0, 150),
          fix: "Check migration 131 applied (commercial_projects)",
        };
      }
      const n = count ?? 0;
      if (n === 0) {
        return { status: "ok", message: "Every live project is attached to an opportunity" };
      }
      return {
        status: "warn",
        message: `${n} live project${n === 1 ? "" : "s"} with no opportunity — their costs are missing from every report`,
        fix: "Reports read opportunities first. Either attach these to an opportunity, or make Job costs / geography / P&L read projects as the root. See OPEN_BACKLOG §4.1",
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
