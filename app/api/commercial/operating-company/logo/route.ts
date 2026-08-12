import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { getBrandLogoBuffer } from "@/lib/commercial/operating-company/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve the operating company's logo.
 *
 * The upload route has existed for a while and `logo_asset_key` is stored, but
 * nothing ever read it back for the SCREEN — only the PDFs resolve it. So
 * uploading a new logo appeared to work and changed the documents alone, while
 * every in-app header kept the bundled Tomco file.
 *
 * Falls back to the bundled image, so a workspace that has never uploaded one
 * looks exactly as it does today.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const profile = await getProfileByUserId(user.id);
  if (!profile?.has_new_platform_access || profile?.is_active === false) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const buf = await getBrandLogoBuffer();
  if (!buf) return NextResponse.json({ error: "no_logo" }, { status: 404 });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      // Short cache: a rebrand should appear without anyone clearing anything,
      // and this is one small image on an authenticated page.
      "Cache-Control": "private, max-age=300",
    },
  });
}
