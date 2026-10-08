import { NextResponse } from "next/server";
import { canOpenPayPages } from "@/lib/payments/access";
import { checkRateLimit } from "@/lib/rate-limit";
import { quoteCardPayment } from "@/lib/payments/service";

export const dynamic = "force-dynamic";

/**
 * POST /pay/<token>/card/quote — { milestone, confirmationToken }.
 *
 * The card has been entered but NOT charged. Reads whether it is credit or
 * debit and returns the amount it would pay. Charges nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await canOpenPayPages())) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Per link and per IP. A real customer needs a handful of tries; a card
  // tester needs hundreds. (Durable per-link decline cap: quoteCardPayment.)
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (
    !checkRateLimit(`paycard:t:${token}`, { max: 20, windowMs: 10 * 60_000 }).ok ||
    !checkRateLimit(`paycard:ip:${ip}`, { max: 40, windowMs: 10 * 60_000 }).ok
  ) {
    return NextResponse.json({ error: "too_many" }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as { milestone?: unknown; confirmationToken?: unknown } | null;
  const milestoneKey = typeof body?.milestone === "string" ? body.milestone : "";
  const confirmationTokenId = typeof body?.confirmationToken === "string" ? body.confirmationToken : "";
  if (!milestoneKey || !confirmationTokenId) return NextResponse.json({ error: "bad_card" }, { status: 400 });

  try {
    const res = await quoteCardPayment({ token, milestoneKey, confirmationTokenId });
    if (!res.ok) {
      if (res.detail) console.warn("[pay] card quote refused", token, res.code, res.detail);
      return NextResponse.json({ error: res.code }, { status: 409 });
    }
    return NextResponse.json({ quote: res.quote });
  } catch (err) {
    console.error("[pay] card quote failed", token, err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
