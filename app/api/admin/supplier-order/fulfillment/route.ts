import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole } from "@/lib/auth/roles";
import { normalizeFulfillmentState } from "@/lib/supplier-order/fulfillment-state";

/**
 * The fulfilment step's own saved entries for one (work order, supplier).
 *
 *   PUT { workOrderId, supplierAccountId, fulfillment }
 *
 * R4.33. Deliberately a separate route from /build, writing a separate column:
 * this endpoint touches `fulfillment` and NEVER `payload`, and /build touches
 * `payload` and never `fulfillment`. That's what preserves the one-way flow
 * Kate asked us not to break — an address edit here cannot reach the typed
 * quantities, structurally rather than by convention.
 *
 * There is no GET: the fulfilment page already loads its row server-side
 * alongside the build payload, so a second round-trip would only add latency.
 *
 * Admin-only, same capability gate as /build, /draft and /send.
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

/** Migration 155 pending — the page still works, it just can't remember. */
function isMissingColumn(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const msg = e?.message ?? "";
  return (
    e?.code === "42P01" ||   // undefined_table
    e?.code === "42703" ||   // undefined_column
    e?.code === "PGRST204" || // PostgREST: column not found in schema cache
    e?.code === "PGRST205" ||
    /column [^\n]*fulfillment[^\n]* does not exist/i.test(msg) ||
    /could not find the '?fulfillment'? column/i.test(msg)
  );
}

export async function PUT(request: Request) {
  const auth = await authorize();
  if (auth.error) return auth.error;

  let body: { workOrderId?: string; supplierAccountId?: string; fulfillment?: unknown };
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

  const fulfillment = normalizeFulfillmentState(body.fulfillment);

  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    // UPDATE, not upsert. A fulfilment autosave must never CREATE the row:
    // reaching this page always means the builder committed one first, and an
    // insert here would write a build row with an empty `payload` — which is
    // precisely the "fulfilment wiped the order" bug we're avoiding.
    const { data, error } = await sb
      .from("supplier_order_builds")
      .update({ fulfillment, updated_at: new Date().toISOString() })
      .eq("work_order_id", workOrderId)
      .eq("supplier_account_id", supplierAccountId)
      .select("id");
    if (error) throw error;
    return NextResponse.json({ ok: true, saved: (data?.length ?? 0) > 0 });
  } catch (err) {
    if (isMissingColumn(err)) {
      return NextResponse.json({ ok: true, saved: false, persistence: "unavailable" });
    }
    console.error("[supplier-order/fulfillment PUT]", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
