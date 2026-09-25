import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { apiAccessDenied, financeApiDenied } from "@/lib/commercial/auth";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { setPaymentDeposited } from "@/lib/commercial/reports/transactions";

/**
 * POST /api/commercial/payments/deposited  { paymentId, deposited }
 *
 * Ticking a payment off against the bank, without re-rendering the page.
 *
 * Karan 2026-09-17: "just make it simple checkboxes that are quick — this
 * Deposited button takes so long to load." It did. It was a form posting to a
 * server action that called `revalidatePath`, so every single tick re-ran the
 * whole Accounting page: the receivables report, the cost breakdown, the
 * project rollups, and 112 rows of ledger. Reconciling a month is thirty of
 * those in a row, each one waiting on a full page rebuild.
 *
 * This route does the one write and nothing else. The checkbox ticks instantly
 * on the client and this confirms it in the background — so the cost of a tick
 * is one small UPDATE rather than a page.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active, is_admin, role")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (await apiAccessDenied(auth.user.id, prof)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  /**
   * FINANCE-GATED, like the server action this route replaced.
   *
   * The action it was carved out of calls `requireFinanceViewer` — admin or
   * account manager — and explains at the top of accounting/page.tsx exactly
   * what a merely-signed-in rep could otherwise do by replaying an action id.
   * Moving the write here for speed dropped the gate to "has commercial
   * access", which every rep has. See financeApiDenied.
   */
  const denied = await financeApiDenied(auth.user.email, prof);
  if (denied) return denied;

  let body: { paymentId?: unknown; deposited?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const paymentId = String(body.paymentId ?? "");
  if (!UUID_RE.test(paymentId)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const res = await setPaymentDeposited(paymentId, body.deposited === true);
  return res.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: res.error }, { status: 500 });
}
