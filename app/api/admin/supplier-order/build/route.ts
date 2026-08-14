import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole } from "@/lib/auth/roles";
import { normalizeBuildPayload, emptyBuildPayload } from "@/lib/supplier-order/build-state";
import { VALID_MATERIAL_TYPE_VALUES } from "@/lib/customer-form/material-types";

/**
 * The committed order-building state for one (work order, supplier).
 *
 *   GET  ?workOrderId=&supplierAccountId=  → { payload, committedAt }
 *   PUT  { workOrderId, supplierAccountId, payload, commit? }
 *
 * Kate round-3 #18. The order builder autosaves here (commit=false) so a
 * remount or a tab switch doesn't lose typed quantities (#20), and commits
 * (commit=true) when the worker advances to fulfilment. The fulfilment step
 * only ever GETs — it cannot mutate the order.
 *
 * Admin-only, same capability gate as the draft + send routes.
 */

async function authorize() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const profile = await getProfileByUserId(data.user.id);
  if (profile && profile.is_active === false && !isAdminEmail(data.user.email)) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  const canOrder = capabilitiesFor(
    normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(data.user.email))
  ).canOrderMaterials;
  if (!canOrder) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { userId: data.user.id };
}

function admin() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * True when the failure is "migration 144 hasn't been applied yet" rather than
 * a real error. This route ships before Karan runs the migration, and the order
 * builder must stay usable in the meantime — it just loses cross-reload
 * persistence until the table exists. Silent degradation beats a dead page.
 */
function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "42P01" || /supplier_order_builds/i.test(e?.message ?? "");
}

export async function GET(request: Request) {
  const auth = await authorize();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const workOrderId = (url.searchParams.get("workOrderId") ?? "").trim();
  const supplierAccountId = (url.searchParams.get("supplierAccountId") ?? "").trim();
  if (!workOrderId || !supplierAccountId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  try {
    const { data, error } = await admin()
      .from("supplier_order_builds")
      .select("payload, committed_at")
      .eq("work_order_id", workOrderId)
      .eq("supplier_account_id", supplierAccountId)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({
      ok: true,
      payload: data ? normalizeBuildPayload(data.payload) : emptyBuildPayload(),
      committedAt: data?.committed_at ?? null,
      exists: !!data,
    });
  } catch (err) {
    if (isMissingTable(err)) {
      // Migration 144 not applied yet — behave like "nothing saved".
      return NextResponse.json({
        ok: true,
        payload: emptyBuildPayload(),
        committedAt: null,
        exists: false,
        persistence: "unavailable",
      });
    }
    console.error("[supplier-order/build GET]", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  const auth = await authorize();
  if (auth.error) return auth.error;

  let body: {
    workOrderId?: string;
    supplierAccountId?: string;
    payload?: unknown;
    commit?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const workOrderId = (body.workOrderId ?? "").trim();
  const supplierAccountId = (body.supplierAccountId ?? "").trim();
  if (!workOrderId || !supplierAccountId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const payload = normalizeBuildPayload(body.payload);

  // Mirror the draft/send routes' allowlist so a tampered payload can't park an
  // unknown paint line in saved state and only blow up at send time.
  const badLines = [payload.mainMaterialType, ...Object.values(payload.materialTypeOverrides)]
    .filter((v) => v && v.trim())
    .filter((v) => !VALID_MATERIAL_TYPE_VALUES.has(v));
  if (badLines.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_material_type",
        message: `Unknown paint line(s): ${badLines.join(", ")}. Pick from the dropdown.`,
      },
      { status: 400 }
    );
  }

  try {
    const now = new Date().toISOString();
    const { error } = await admin()
      .from("supplier_order_builds")
      .upsert(
        {
          work_order_id: workOrderId,
          supplier_account_id: supplierAccountId,
          payload,
          // Autosaves leave committed_at alone by writing null only on the
          // first insert; a commit stamps it. Re-editing after a commit keeps
          // the old stamp — the order stays "built", it's just been revised.
          ...(body.commit ? { committed_at: now } : {}),
          created_by_user_id: auth.userId,
          updated_at: now,
        },
        { onConflict: "work_order_id,supplier_account_id" }
      );
    if (error) throw error;
    return NextResponse.json({ ok: true, payload, committed: !!body.commit });
  } catch (err) {
    if (isMissingTable(err)) {
      // Migration 144 pending. Hand the payload straight back so the builder
      // carries on in memory — the worker keeps their typed quantities for this
      // session, they just don't survive a reload until the table lands.
      return NextResponse.json({
        ok: true,
        payload,
        committed: !!body.commit,
        persistence: "unavailable",
      });
    }
    console.error("[supplier-order/build PUT]", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
