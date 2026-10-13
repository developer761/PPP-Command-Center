import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { demoConfirmationToken } from "@/lib/payments/service";

export const dynamic = "force-dynamic";

/**
 * POST /pay/<token>/card/demo-card — { card: "credit" | "debit" }.
 *
 * Sales demo only: hands back a ConfirmationToken for one of Stripe's test
 * cards, so the demo can be paid on a phone without typing a card number.
 * 404 for every link that isn't a demo link while the demo is on with a TEST
 * Stripe key (demoConfirmationToken checks both).
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
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
