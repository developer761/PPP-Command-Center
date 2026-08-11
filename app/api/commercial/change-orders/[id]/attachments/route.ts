import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { UUID_RE } from "@/lib/commercial/uuid";
import { attachChangeOrderFile, removeChangeOrderAttachment } from "@/lib/commercial/change-orders/attachments";
import { verifyFileMagicBytes } from "@/lib/commercial/accounts/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX = 50 * 1024 * 1024; // 50 MB
const ALLOWED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Attach a file to (or remove one from) a specific change order. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Crew logins are page-allowlisted only; this API tree is not covered by
  // that gate, so deny here (see denyCrewApi).
  { const denied = await denyCrewApi(user.id); if (denied) return denied; }
  const profile = await getProfileByUserId(user.id);
  if (!profile?.has_new_platform_access || profile?.is_active === false) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData();

  const removeId = String(form.get("remove_document_id") ?? "");
  if (removeId) {
    if (!UUID_RE.test(removeId)) return NextResponse.json({ error: "bad_id" }, { status: 400 });
    const res = await removeChangeOrderAttachment(id, removeId, user.id);
    return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Pick a file to attach (PDF or image)." }, { status: 400 });
  }
  if (file.size > MAX) return NextResponse.json({ error: "File too big (max 50 MB)." }, { status: 400 });
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: "Upload a PDF or image." }, { status: 400 });

  const data = new Uint8Array(await file.arrayBuffer());
  // Sniff the real content — a renamed executable can DECLARE application/pdf,
  // so trust the bytes, not file.type (2026-08 backend audit #10).
  const magic = verifyFileMagicBytes(data, file.type);
  if (!magic.ok) return NextResponse.json({ error: `This file looks like ${magic.detected}, not a PDF or image.` }, { status: 400 });
  const res = await attachChangeOrderFile({
    changeOrderId: id,
    file_name: file.name || "change-order.pdf",
    mime_type: file.type,
    data,
    actorUserId: user.id,
  });
  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
}
