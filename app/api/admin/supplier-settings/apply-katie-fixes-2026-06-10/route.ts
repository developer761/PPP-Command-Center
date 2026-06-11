import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * One-shot data-fix endpoint for Katie's batch 2026-06-10:
 *
 *  1. Activate every supplier_settings row (the picker was hiding 3
 *     suppliers because is_active=false; per Katie they should all be
 *     usable on a paint order).
 *  2. Update Ricciardi (any row whose name contains "Ricciardi") to
 *     order_email = Greenbrook@ricciardibrothers.com.
 *  3. Mark Janovic phone_only=true + pickup_default=true (NYC supplier,
 *     doesn't accept email orders per Katie).
 *  4. Set pickup_default=true on rows whose name contains "Ricciardi"
 *     OR "Janovic" (Katie: NYC suppliers default to pickup).
 *
 * Idempotent — safe to re-run; UPDATE statements only set the named
 * fields. Admin-only.
 *
 * Usage: signed in as admin, POST to /api/admin/supplier-settings/apply-katie-fixes-2026-06-10
 * Returns a diff of what changed.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(authData.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(authData.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sb = adminClient();
  const summary: Record<string, unknown> = {};

  // 1. Activate every supplier_settings row.
  const { data: actData, error: actErr } = await sb
    .from("supplier_settings")
    .update({ is_active: true })
    .eq("is_active", false)
    .select("supplier_account_id, supplier_name");
  if (actErr) {
    return NextResponse.json({ error: "activate_failed", message: actErr.message }, { status: 500 });
  }
  summary.activated = actData ?? [];

  // 2. Update Ricciardi email — match any row with "ricciardi" anywhere in
  //    the name (case-insensitive) so we don't have to know the exact
  //    `supplier_account_id` upstream.
  const { data: ricData, error: ricErr } = await sb
    .from("supplier_settings")
    .update({ order_email: "Greenbrook@ricciardibrothers.com" })
    .ilike("supplier_name", "%ricciardi%")
    .select("supplier_account_id, supplier_name, order_email");
  if (ricErr) {
    return NextResponse.json({ error: "ricciardi_update_failed", message: ricErr.message }, { status: 500 });
  }
  summary.ricciardiUpdated = ricData ?? [];

  // 3. Janovic — phone-only, pickup default. Email cleared so workers can't
  //    accidentally hit Send (the picker uses the phone affordance instead).
  const { data: janData, error: janErr } = await sb
    .from("supplier_settings")
    .update({
      phone_only: true,
      pickup_default: true,
      // We don't have Janovic's number yet — admin can fill it in via the
      // settings editor. Leaving null surfaces a hint in the modal until
      // it's set.
    })
    .ilike("supplier_name", "%janovic%")
    .select("supplier_account_id, supplier_name, phone_only, pickup_default");
  if (janErr) {
    return NextResponse.json({ error: "janovic_update_failed", message: janErr.message }, { status: 500 });
  }
  summary.janovicUpdated = janData ?? [];

  // 4. NYC pickup-default for known-NYC suppliers (Ricciardi, Janovic).
  //    Other NYC suppliers can be flagged manually in the settings editor
  //    once admin confirms their fulfillment behavior with Katie.
  const { data: pickupData, error: pickupErr } = await sb
    .from("supplier_settings")
    .update({ pickup_default: true })
    .or("supplier_name.ilike.%ricciardi%,supplier_name.ilike.%janovic%")
    .select("supplier_account_id, supplier_name, pickup_default");
  if (pickupErr) {
    return NextResponse.json({ error: "pickup_update_failed", message: pickupErr.message }, { status: 500 });
  }
  summary.pickupDefaultSet = pickupData ?? [];

  // 5. Diagnostic: full current state.
  const { data: allRows } = await sb
    .from("supplier_settings")
    .select("supplier_account_id, supplier_name, order_email, is_active, phone_only, phone_number, pickup_default")
    .order("supplier_name", { ascending: true });
  summary.currentState = allRows ?? [];

  return NextResponse.json({ ok: true, summary });
}
