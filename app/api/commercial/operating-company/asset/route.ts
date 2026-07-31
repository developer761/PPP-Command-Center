import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { uploadBrandAsset, clearBrandAsset, MAX_BRAND_BYTES } from "@/lib/commercial/operating-company/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upload (or clear) the operating company's logo / signature image. Admin-only. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

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
