import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createClient as createAdminClient } from "@supabase/supabase-js";

/**
 * Setup Health — admin-only diagnostic that catches platform-wide
 * misconfigurations that would silently break customer-facing flows.
 *
 * Examples it catches:
 *  - An active supplier with no order email → admin would hit Send and
 *    the modal would block, OR worse, the order would silently land in
 *    a dead recipient if a fallback was added later.
 *  - RESEND_FROM_ADDRESS unset → vendor replies don't thread back to
 *    the inbox; admin only finds out when a customer complains.
 *  - RESEND_*_SECRET missing → delivery tracking + inbound reply
 *    ingestion silently no-op.
 *  - Migrations 011/012 not run → cross-server cache coherence falls
 *    back to the slower legacy path silently.
 *
 * Returns:
 *   { ok, checks: [{ id, label, status: "ok"|"warn"|"fail", message, fix? }] }
 *
 * Soft-fails on any individual check; one broken check doesn't take
 * down the whole page.
 */

export type HealthStatus = "ok" | "warn" | "fail";
export type HealthCheck = {
  id: string;
  label: string;
  status: HealthStatus;
  message: string;
  /** Optional "where to fix it" pointer (settings page url or env var name). */
  fix?: string;
};

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET() {
  // Admin gate
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(userData.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(userData.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const checks: HealthCheck[] = [];

  // ── Env vars: email infrastructure ────────────────────────────────────
  const envChecks: Array<{ id: string; label: string; envVar: string; missingMessage: string; presentMessage: string; severity: HealthStatus }> = [
    {
      id: "resend_from",
      label: "Email From address (RESEND_FROM_ADDRESS)",
      envVar: "RESEND_FROM_ADDRESS",
      severity: "fail",
      missingMessage: "Without this, every email the platform sends defaults to the Resend sandbox address and supplier replies never thread back to the inbox.",
      presentMessage: "Set — vendor replies will thread back to the inbox.",
    },
    {
      id: "resend_events_secret",
      label: "Email delivery tracking (RESEND_EVENTS_SECRET)",
      envVar: "RESEND_EVENTS_SECRET",
      severity: "warn",
      missingMessage: "Delivery-status events from Resend (opened / bounced / delivered) will be silently dropped — the Sent tab will show every email as 'waiting' forever.",
      presentMessage: "Set — opened / bounced / delivered events update the Sent tab.",
    },
    {
      id: "resend_inbound_secret",
      label: "Inbound reply ingestion (RESEND_INBOUND_SECRET)",
      envVar: "RESEND_INBOUND_SECRET",
      severity: "warn",
      missingMessage: "Supplier and customer reply emails won't be ingested into the Mail Hub inbox. Admin would have to check Gmail manually.",
      presentMessage: "Set — replies are ingested into the Mail Hub.",
    },
    // GENERAL_SUPPLIES_EMAIL check removed 2026-06-02 — workers now order
    // loose supplies (rollers, brushes, drop cloths) directly from their
    // configured paint suppliers (Aboffs/Willis/Janovic/etc., which carry
    // those items too), not through a separate "General Supplies" recipient.
    // Legacy "__general__" plumbing is kept in the backend for backward-
    // compatible rendering of existing sent orders, but isn't on the
    // happy-path flow anymore.
  ];
  for (const c of envChecks) {
    const value = process.env[c.envVar];
    const present = !!(value && value.trim());
    checks.push({
      id: c.id,
      label: c.label,
      status: present ? "ok" : c.severity,
      message: present ? c.presentMessage : c.missingMessage,
      fix: present ? undefined : `Set ${c.envVar} in Vercel → Project Settings → Environment Variables.`,
    });
  }

  // ── Active suppliers with missing order email ─────────────────────────
  try {
    const { data: suppliers, error: supErr } = await adminClient()
      .from("supplier_settings")
      .select("supplier_account_id, supplier_name, order_email, is_active")
      .eq("is_active", true);
    if (supErr) throw supErr;
    const activeCount = (suppliers ?? []).length;
    const missingEmail = (suppliers ?? []).filter(
      (s) => !s.order_email || !String(s.order_email).trim()
    );
    if (activeCount === 0) {
      checks.push({
        id: "active_suppliers",
        label: "Active suppliers configured",
        status: "warn",
        message: "No suppliers are flagged active. Workers can still pick from the full Salesforce list, but the curated quick-pick will be empty.",
        fix: "/dashboard/settings/suppliers",
      });
    } else if (missingEmail.length > 0) {
      checks.push({
        id: "active_suppliers",
        label: "Active suppliers configured",
        status: "fail",
        message: `${missingEmail.length} active supplier${missingEmail.length === 1 ? "" : "s"} ${missingEmail.length === 1 ? "has" : "have"} no order email: ${missingEmail.map((s) => s.supplier_name ?? s.supplier_account_id).join(", ")}. Orders to ${missingEmail.length === 1 ? "this supplier" : "these suppliers"} cannot Send (button is blocked).`,
        fix: "/dashboard/settings/suppliers",
      });
    } else {
      checks.push({
        id: "active_suppliers",
        label: "Active suppliers configured",
        status: "ok",
        message: `${activeCount} active supplier${activeCount === 1 ? "" : "s"}, all with order emails set.`,
      });
    }
  } catch (err) {
    checks.push({
      id: "active_suppliers",
      label: "Active suppliers configured",
      status: "warn",
      message: `Couldn't read supplier_settings: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ── Migration 011: snapshot_generation table ──────────────────────────
  try {
    const { error } = await adminClient()
      .from("snapshot_generation")
      .select("generation")
      .eq("key", "global")
      .maybeSingle();
    if (error) throw error;
    checks.push({
      id: "migration_011",
      label: "Cross-server cache coherence (migration 011)",
      status: "ok",
      message: "snapshot_generation table exists — post-writeback cache invalidation propagates to all Vercel instances within 5s.",
    });
  } catch (err) {
    checks.push({
      id: "migration_011",
      label: "Cross-server cache coherence (migration 011)",
      status: "warn",
      message: `snapshot_generation table missing — cross-server cache lag falls back to the 15-minute TTL. ${err instanceof Error ? err.message : ""}`.trim(),
      fix: "Paste supabase/migrations/011_snapshot_generation.sql into the Supabase SQL editor + run.",
    });
  }

  // Migration 012 (atomic bump RPC) deliberately NOT probed here — the only
  // way to test the RPC is to CALL it, which bumps the counter and
  // invalidates every server's local cache on each health-page load.
  // The runtime falls back gracefully when the RPC is missing (warning
  // logged the first time bumpGeneration runs), so we let production logs
  // surface that signal rather than checking it here.

  // ── Migration 013: paint coverage config ──────────────────────────────
  try {
    const { error } = await adminClient()
      .from("paint_coverage_config")
      .select("key")
      .eq("key", "default")
      .maybeSingle();
    if (error) throw error;
    checks.push({
      id: "migration_013",
      label: "Paint coverage settings (migration 013)",
      status: "ok",
      message: "paint_coverage_config table exists — admin can tune the gallon calculator from /dashboard/settings/coverage without a deploy.",
    });
  } catch (err) {
    checks.push({
      id: "migration_013",
      label: "Paint coverage settings (migration 013)",
      status: "warn",
      message: `paint_coverage_config table missing — coverage settings silently fall back to code defaults. ${err instanceof Error ? err.message : ""}`.trim(),
      fix: "Paste supabase/migrations/013_paint_coverage_config.sql (if it exists) into the Supabase SQL editor + run.",
    });
  }

  // Aggregate summary
  const summary = {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
    total: checks.length,
  };

  return NextResponse.json({ ok: true, checks, summary });
}
