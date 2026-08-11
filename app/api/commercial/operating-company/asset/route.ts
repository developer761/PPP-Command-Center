import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { uploadBrandAsset, clearBrandAsset, MAX_BRAND_BYTES } from "@/lib/commercial/operating-company/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upload (or clear) the operating company's logo / signature image. Any
 *  commercial user (roles are open for now). Non-redirecting JSON responses. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Crew logins are page-allowlisted only; this API tree is not covered by
  // that gate, so deny here (see denyCrewApi).
  { const denied = await denyCrewApi(user.id); if (denied) return denied; }
  const profile = await getProfileByUserId(user.id);
  if (!profile?.has_new_platform_access || profile?.is_active === false) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData();
  const kind = String(form.get("kind") ?? "");
  if (kind !== "logo" && kind !== "signature") {
    return NextResponse.json({ error: "bad_kind" }, { status: 400 });
  }

  // Clear branch.
  if (String(form.get("clear") ?? "") === "1") {
    const res = await clearBrandAsset(kind, user.id);
    return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Pick an image file." }, { status: 400 });
  }
  if (file.size > MAX_BRAND_BYTES) {
    return NextResponse.json({ error: "Image too big (max 5 MB)." }, { status: 400 });
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const res = await uploadBrandAsset({ kind, data, mime: file.type, actorUserId: user.id });
  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
}
