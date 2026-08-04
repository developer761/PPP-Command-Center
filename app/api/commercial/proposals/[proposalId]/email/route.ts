import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { emailProposalToGc } from "@/lib/commercial/proposals/email";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";

/**
 * POST /api/commercial/proposals/[proposalId]/email — Kim: email the approved
 * proposal PDF to the GC via Resend. Body (from the review sheet):
 *   { to_email, to_name?, cc_email?, subject, message }
 *
 * Auth: signed in + has_new_platform_access. The R1 approval hard-gate is
 * re-checked inside emailProposalToGc (never trust the client on status).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ proposalId: string }> }
) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { proposalId } = await params;
    if (!proposalId || !UUID_RE.test(proposalId)) {
      return NextResponse.json({ error: "invalid_proposal_id" }, { status: 400 });
    }

    const sb = commercialDb();
    const { data: profile } = await sb
      .from("profiles")
      .select("has_new_platform_access, is_active, sf_user_name")
      .eq("user_id", data.user.id)
      .maybeSingle();
    if (rawAccessDenied(profile)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const result = await emailProposalToGc({
      proposal_id: proposalId,
      actor_user_id: data.user.id,
      actor_name: (profile as { sf_user_name?: string | null } | null)?.sf_user_name ?? undefined,
      actor_email: data.user.email ?? null,
      to_email: String(body.to_email ?? ""),
      to_name: typeof body.to_name === "string" ? body.to_name : null,
      cc_email: typeof body.cc_email === "string" ? body.cc_email : null,
      subject: String(body.subject ?? "").slice(0, 300),
      message: String(body.message ?? "").slice(0, 8000),
    });
    if (!result.ok) {
      return NextResponse.json({ error: "send_failed", detail: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, send: result.send });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[commercial/proposals/email] unhandled: ${message}`);
    return NextResponse.json({ error: "internal_error", detail: message }, { status: 500 });
  }
}
