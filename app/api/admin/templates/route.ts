import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  loadTemplates,
  saveTemplates,
  DEFAULT_TEMPLATES,
  type Templates,
} from "@/lib/customer-form/templates";

/**
 * Admin templates editor backend.
 *
 *   GET  /api/admin/templates
 *     → { templates, defaults, isCustomized, updatedAt }
 *     Returns the EFFECTIVE templates (DB merged over defaults) PLUS the
 *     raw code defaults so the UI can show "reset to default" for each
 *     field individually.
 *
 *   PUT  /api/admin/templates
 *     body: Partial<Templates> — only the fields the admin actually edited.
 *     Pass null for a field to clear the DB override (revert to default).
 *     → { ok: true } on success
 *
 * Admin-only. Writes audit info (updated_by_user_id) so we can see who last
 * changed the customer-facing copy.
 */

export async function GET() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { templates, isCustomized, updatedAt } = await loadTemplates();
  return NextResponse.json({
    templates,
    defaults: DEFAULT_TEMPLATES,
    isCustomized,
    updatedAt,
  });
}

export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Partial<Record<keyof Templates, string | null>>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Whitelist the keys we accept — guards against arbitrary column writes.
  const allowedKeys = new Set(Object.keys(DEFAULT_TEMPLATES) as Array<keyof Templates>);
  const sanitized: Partial<Record<keyof Templates, string | null>> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!allowedKeys.has(k as keyof Templates)) continue;
    // Treat empty string === null (clear to default) to keep the UI simple
    if (v === null || (typeof v === "string" && v.trim().length === 0)) {
      sanitized[k as keyof Templates] = null;
    } else if (typeof v === "string") {
      sanitized[k as keyof Templates] = v;
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const result = await saveTemplates(sanitized, data.user.id);
  if (!result.ok) {
    return NextResponse.json({ error: "save_failed", message: result.error }, { status: 500 });
  }

  // Return the FRESH merged templates so the UI doesn't need a follow-up GET
  const { templates, updatedAt } = await loadTemplates();
  return NextResponse.json({ ok: true, templates, updatedAt });
}
