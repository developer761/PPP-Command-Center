import { NextResponse } from "next/server";
import { getSignedInAdminEmail } from "@/lib/payments/access";
import { connectSandbox, paymentsOrg } from "@/lib/salesforce/payments-org";

export const dynamic = "force-dynamic";

/** Salesforce sandbox OAuth callback. Stores the sandbox login under its own keys. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const back = (k: "ok" | "err", m: string) =>
    NextResponse.redirect(`${origin}/dashboard/settings/payments?${k}=${encodeURIComponent(m)}`);
  const email = await getSignedInAdminEmail();
  if (!email) return NextResponse.redirect(`${origin}/dashboard`);
  if (paymentsOrg() !== "sandbox") return back("err", "Not in sandbox mode (PAYMENTS_SF_ORG=sandbox).");
  const err = searchParams.get("error");
  if (err) return back("err", `Salesforce said: ${err}`);
  const code = searchParams.get("code");
  if (!code) return back("err", "No authorization code came back from Salesforce.");
  try {
    const instance = await connectSandbox(code, `${origin}/api/auth/salesforce-sandbox/callback`, email);
    return back("ok", `Payments are connected to the sandbox: ${instance}`);
  } catch (e) {
    console.error("[sf-sandbox-callback]", e);
    return back("err", e instanceof Error ? e.message : String(e));
  }
}
