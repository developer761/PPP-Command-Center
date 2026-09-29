import { NextResponse } from "next/server";
import { canOpenPayPages } from "@/lib/payments/access";
import { createCheckout, type CheckoutErrorCode } from "@/lib/payments/service";

export const dynamic = "force-dynamic";

/**
 * POST /pay/<token>/checkout — a Pay button. Takes only which milestone and
 * which method. Card → the card page (/pay/<token>/card). Bank → the amount is
 * recomputed from Salesforce inside createCheckout, then 303 to Stripe's hosted
 * checkout, or back to the pay page with an error code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await canOpenPayPages())) return new NextResponse("Not found", { status: 404 });

  const origin = new URL(request.url).origin;
  const back = (code: CheckoutErrorCode) => NextResponse.redirect(`${origin}/pay/${token}?err=${code}`, 303);

  const form = await request.formData();
  const milestoneKey = String(form.get("milestone") ?? "");
  const method = String(form.get("method") ?? "");
  if (!milestoneKey || (method !== "card" && method !== "ach")) {
    return back("no_method");
  }
  // Card payments run on our own page, where the fee can depend on whether the
  // card is credit or debit. Only bank payments go to hosted Checkout.
  if (method === "card") {
    return NextResponse.redirect(`${origin}/pay/${token}/card?m=${encodeURIComponent(milestoneKey)}`, 303);
  }

  try {
    const res = await createCheckout({ token, milestoneKey, origin });
    if (!res.ok) {
      if (res.detail) console.warn("[pay] checkout refused", token, res.code, res.detail);
      return back(res.code);
    }
    return NextResponse.redirect(res.url, 303);
  } catch (err) {
    console.error("[pay] checkout failed", token, err);
    return back("failed");
  }
}
