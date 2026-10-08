import { NextResponse } from "next/server";
import { canOpenPayPages } from "@/lib/payments/access";
import { checkRateLimit } from "@/lib/rate-limit";
import { payByCard } from "@/lib/payments/service";

export const dynamic = "force-dynamic";

/**
 * POST /pay/<token>/card/confirm — { milestone, confirmationToken, shownTotalCents }.
 *
 * The customer pressed Pay on the amount they were shown. payByCard recomputes
 * everything and refuses (without charging) if the amount no longer matches.
 * `shownTotalCents` is only ever compared, never charged.
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

  const body = (await request.json().catch(() => null)) as {
    milestone?: unknown;
    confirmationToken?: unknown;
    shownTotalCents?: unknown;
  } | null;
  const milestoneKey = typeof body?.milestone === "string" ? body.milestone : "";
  const confirmationTokenId = typeof body?.confirmationToken === "string" ? body.confirmationToken : "";
  const shownTotalCents = typeof body?.shownTotalCents === "number" ? body.shownTotalCents : NaN;
  if (!milestoneKey || !confirmationTokenId || !Number.isInteger(shownTotalCents)) {
    return NextResponse.json({ error: "bad_card" }, { status: 400 });
  }

  try {
    const res = await payByCard({
      token,
      milestoneKey,
      confirmationTokenId,
      shownTotalCents,
      origin: new URL(request.url).origin,
    });
    if (!res.ok) return NextResponse.json({ error: res.code, message: res.message, quote: res.quote }, { status: 409 });
    return NextResponse.json(res);
  } catch (err) {
    console.error("[pay] card payment failed", token, err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
