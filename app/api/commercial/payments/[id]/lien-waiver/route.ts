import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { UUID_RE } from "@/lib/commercial/uuid";
import { attachPaymentLienWaiver, removePaymentLienWaiver } from "@/lib/commercial/invoices/payment-lien-waiver";
import { verifyFileMagicBytes } from "@/lib/commercial/accounts/documents";
import { SAFE_MULTIPART_BYTES } from "@/lib/commercial/uploads/size-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The body arrives as multipart through a Vercel serverless function, which
// rejects anything over ~4.5 MB at the EDGE — before this handler runs. Proved
// against production 2026-09-23: a 100 KB POST here returns 401 (our auth), a
// 6 MB POST returns 413 (the platform). So the cap below is the PLATFORM's,
// not a policy choice, and a larger number here would be fiction: the check
// could never execute. The browser-side guard in lib/commercial/uploads/
// size-limit.ts refuses oversized files first, with an explanation.
const MAX = SAFE_MULTIPART_BYTES;
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic", "image/heif"]);

/** Upload (or remove) the PARTIAL lien waiver for one progress payment. Mirrors
 *  the invoice/milestone waiver route exactly (same auth, limits, JSON shape). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Crew logins are page-allowlisted only; this API tree is not covered by
  // that gate, so deny here (see denyCrewApi).
  { const denied = await denyCrewApi(user.id); if (denied) return denied; }
  // Non-redirecting access check — a route handler returns JSON 403, never a 307.
  const profile = await getProfileByUserId(user.id);
  if (!profile?.has_new_platform_access || profile?.is_active === false) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData();

  if (String(form.get("remove") ?? "") === "1") {
    const res = await removePaymentLienWaiver(id, user.id);
    return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Pick a lien-waiver file (PDF or image)." }, { status: 400 });
  }
  if (file.size > MAX) return NextResponse.json({ error: `File too big (${(file.size / 1024 / 1024).toFixed(1)} MB). This slot posts through the server, which caps at ${(MAX / 1024 / 1024).toFixed(0)} MB — put the file on the deal's Documents / Files tab and attach it from there.` }, { status: 400 });
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: "Upload a PDF or image." }, { status: 400 });

  const data = new Uint8Array(await file.arrayBuffer());
  const magic = verifyFileMagicBytes(data, file.type);
  if (!magic.ok) return NextResponse.json({ error: `This file looks like ${magic.detected}, not a PDF or image.` }, { status: 400 });
  const res = await attachPaymentLienWaiver({
    paymentId: id,
    file_name: file.name || "lien-waiver.pdf",
    mime_type: file.type,
    data,
    actorUserId: user.id,
  });
  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
}
