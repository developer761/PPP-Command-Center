import { NextResponse } from "next/server";
import { canOpenPayPages } from "@/lib/payments/access";
import { checkRateLimit } from "@/lib/rate-limit";
import { demoConfirmationToken } from "@/lib/payments/service";

export const dynamic = "force-dynamic";

/**
 * POST /pay/<token>/card/demo-card — { card: "credit" | "debit" }.
 *
 * Test mode only: hands back a ConfirmationToken for one of Stripe's test
 * cards, so a demo or a sandbox Work Order can be paid on a phone without
 * typing a card number. 404 unless the Stripe key is a TEST key and the link
 * is live (demoConfirmationToken checks both). It never opens a page: the
 * card page's own access rules still decide who gets this far.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await canOpenPayPages(token))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(`paydemo:ip:${ip}`, { max: 30, windowMs: 10 * 60_000 }).ok) {
    return NextResponse.json({ error: "too_many" }, { status: 429 });
  }
  const body = (await request.json().catch(() => null)) as { card?: unknown } | null;
  const card = body?.card === "credit" || body?.card === "debit" ? body.card : null;
  if (!card) return NextResponse.json({ error: "bad_card" }, { status: 400 });
  try {
    const ct = await demoConfirmationToken(token, card);
    if (!ct) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ confirmationToken: ct });
  } catch (err) {
    console.error("[pay] demo card failed", token, err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
