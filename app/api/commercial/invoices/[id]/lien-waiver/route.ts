import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { UUID_RE } from "@/lib/commercial/uuid";
import { attachInvoiceLienWaiver, removeInvoiceLienWaiver } from "@/lib/commercial/invoices/lien-waiver";
import { verifyFileMagicBytes } from "@/lib/commercial/accounts/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX = 50 * 1024 * 1024; // 50 MB — a scanned/emailed waiver PDF
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic", "image/heif"]);

/** Upload (or remove) the lien waiver for one invoice/milestone. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Non-redirecting access check — a route handler must return a JSON 403, not
  // redirect (a 307 the client would mistake for success).
  const profile = await getProfileByUserId(user.id);
  if (!profile?.has_new_platform_access || profile?.is_active === false) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData();

  if (String(form.get("remove") ?? "") === "1") {
    const res = await removeInvoiceLienWaiver(id, user.id);
    return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Pick a lien-waiver file (PDF or image)." }, { status: 400 });
  }
  if (file.size > MAX) return NextResponse.json({ error: "File too big (max 50 MB)." }, { status: 400 });
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: "Upload a PDF or image." }, { status: 400 });

  const data = new Uint8Array(await file.arrayBuffer());
  const magic = verifyFileMagicBytes(data, file.type);
  if (!magic.ok) return NextResponse.json({ error: `This file looks like ${magic.detected}, not a PDF or image.` }, { status: 400 });
  const res = await attachInvoiceLienWaiver({
    invoiceId: id,
    file_name: file.name || "lien-waiver.pdf",
    mime_type: file.type,
    data,
    actorUserId: user.id,
  });
  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
}
