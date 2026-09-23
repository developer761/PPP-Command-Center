import { NextResponse } from "next/server";
import { denyCrewApi } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { UUID_RE } from "@/lib/commercial/uuid";
import { linkLienWaiverDocument, type LienWaiverTarget } from "@/lib/commercial/invoices/lien-waiver-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TARGETS = new Set<LienWaiverTarget>(["invoice", "milestone", "payment", "aia"]);

/**
 * POST /api/commercial/lien-waivers/link
 * Body: { target: "invoice" | "milestone" | "payment" | "aia", id, document_id }
 *
 * File an already-uploaded document as the lien waiver for one slot.
 *
 * The JSON body carries no bytes, which is the entire point: the four
 * byte-posting routes inherit Vercel's ~4.5 MB request cap, so a scanned
 * waiver — routinely 5–15 MB — could not be filed at all. The file now goes
 * browser → Storage through the Documents sign/PUT/finalize path that already
 * handles the full upload limit, and this call is the last, tiny step.
 *
 * Same auth as the routes it replaces. Scope (does this document belong to
 * this job?) is enforced in linkLienWaiverDocument, next to the data.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  {
    const denied = await denyCrewApi(user.id);
    if (denied) return denied;
  }
  const profile = await getProfileByUserId(user.id);
  if (!profile?.has_new_platform_access || profile?.is_active === false) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { target?: string; id?: string; document_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const target = String(body.target ?? "") as LienWaiverTarget;
  if (!TARGETS.has(target)) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  if (!UUID_RE.test(String(body.id ?? ""))) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  if (!UUID_RE.test(String(body.document_id ?? ""))) {
    return NextResponse.json({ error: "bad_document_id" }, { status: 400 });
  }

  const res = await linkLienWaiverDocument({
    target,
    id: String(body.id),
    documentId: String(body.document_id),
    actorUserId: user.id,
  });
  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 });
}
