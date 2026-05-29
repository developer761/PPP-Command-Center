import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { COVERAGE_CONFIG } from "@/lib/supplier-order/estimate-gallons";
import { mergeCoverageConfig, isValidCoverageValue, STRICT_POSITIVE_KEYS, MAX_COVERAGE_VALUES } from "@/lib/supplier-order/coverage-config";

/**
 * Paint-coverage config admin endpoint (Settings → Coverage).
 *
 *   GET — returns { defaults, override, effective }
 *           defaults  = code COVERAGE_CONFIG (the reset target)
 *           override  = the stored partial overrides (what admin changed)
 *           effective = defaults merged with override (what the calc uses)
 *   PUT — body { config: { <key>: number, … } } upserts the override row.
 *
 * Admin-only. Stores only known numeric keys; everything else is ignored.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

async function requireAdmin() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return { error: "unauthorized" as const, status: 401, user: null };
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) return { error: "forbidden" as const, status: 403, user: null };
  return { error: null, status: 200, user: data.user };
}

export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

  let override: Record<string, number> = {};
  try {
    const { data } = await adminClient()
      .from("paint_coverage_config")
      .select("config")
      .eq("key", "default")
      .maybeSingle();
    if (data?.config && typeof data.config === "object") override = data.config as Record<string, number>;
  } catch (err) {
    console.warn("[coverage-config GET] load failed (using defaults):", err);
  }

  return NextResponse.json({
    ok: true,
    defaults: COVERAGE_CONFIG,
    override,
    effective: mergeCoverageConfig(override),
  });
}

export async function PUT(request: Request) {
  const gate = await requireAdmin();
  if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

  let body: { config?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body.config || typeof body.config !== "object") {
    return NextResponse.json({ error: "missing_config" }, { status: 400 });
  }

  // Keep only known numeric keys with valid values.
  const clean: Record<string, number> = {};
  for (const key of Object.keys(COVERAGE_CONFIG) as Array<keyof typeof COVERAGE_CONFIG>) {
    const v = body.config[key as string];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!isValidCoverageValue(key as string, v)) {
      const max = MAX_COVERAGE_VALUES[key as string];
      const minRule = STRICT_POSITIVE_KEYS.has(key as string) ? "greater than 0" : "0 or more";
      const message = max !== undefined
        ? `${key} must be ${minRule} and no more than ${max}`
        : `${key} must be ${minRule}`;
      return NextResponse.json({ error: "invalid_value", message }, { status: 400 });
    }
    clean[key as string] = v;
  }

  try {
    const { error } = await adminClient()
      .from("paint_coverage_config")
      .upsert(
        { key: "default", config: clean, updated_by_user_id: gate.user!.id, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    if (error) {
      return NextResponse.json({ error: "save_failed", message: error.message }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json({ error: "save_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true, override: clean, effective: mergeCoverageConfig(clean) });
}
