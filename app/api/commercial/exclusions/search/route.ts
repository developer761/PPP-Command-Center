/**
 * GET /api/commercial/exclusions/search?q=... — powers the <ExclusionPicker>
 * combobox. Returns up to 25 rows matching the query on `text`.
 * Standard-category rows always float to the top; within a category
 * rows sort by use_count DESC + text ASC.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { listExclusions, createExclusion } from "@/lib/commercial/exclusions/db";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile?.has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const rows = await listExclusions({
    search: q || undefined,
    activeOnly: true,
  });
  return NextResponse.json({
    exclusions: rows.slice(0, 25).map((r) => ({
      id: r.id,
      text: r.text,
      category: r.category,
      use_count: r.use_count,
    })),
  });
}

/**
 * POST /api/commercial/exclusions/search — inline-add path from the
 * <ExclusionPicker> "Add ‘…’ to library" fallback. Creates an optional
 * category row scoped to the current user + returns the created row so
 * the picker can add it to `selected` without a re-fetch.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile?.has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const text = String(body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "text_required" }, { status: 400 });
  }
  const result = await createExclusion({
    text,
    category: "optional",
    created_by_user_id: auth.user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({
    exclusion: {
      id: result.exclusion.id,
      text: result.exclusion.text,
      category: result.exclusion.category,
      use_count: result.exclusion.use_count,
    },
  });
}
