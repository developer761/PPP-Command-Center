import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSignedInAdminEmail } from "@/lib/payments/access";
import { paymentsOrg, sandboxAuthorizationUrl } from "@/lib/salesforce/payments-org";
import { SANDBOX_STATE_COOKIE, SANDBOX_STATE_PREFIX } from "@/lib/salesforce/sandbox-callback";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/salesforce-sandbox/login — connect the PAYMENTS code to a
 * Salesforce sandbox for testing. Stored apart from the production login,
 * which this never touches (see lib/salesforce/payments-org.ts). Admin only,
 * and only when the server runs with PAYMENTS_SF_ORG=sandbox.
 *
 * Returns through the app-wide callback URL by default, because the sandbox's
 * copy of the Connected App only lists production's callback URLs; the OAuth
 * state routes it to the sandbox handler (lib/salesforce/sandbox-callback.ts).
 * SF_SANDBOX_CALLBACK=dedicated uses /api/auth/salesforce-sandbox/callback
 * instead, once that URL is on the sandbox app.
 */
export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  if (!(await getSignedInAdminEmail())) return NextResponse.redirect(`${origin}/dashboard`);
  if (paymentsOrg() !== "sandbox") {
    return NextResponse.redirect(
      `${origin}/dashboard/settings/payments?err=${encodeURIComponent("Start the server with PAYMENTS_SF_ORG=sandbox to connect a sandbox.")}`,
    );
  }
  const dedicated = process.env.SF_SANDBOX_CALLBACK?.trim() === "dedicated";
  const redirectUri = `${origin}/api/auth/salesforce${dedicated ? "-sandbox" : ""}/callback`;
  const nonce = randomBytes(16).toString("base64url");
  try {
    const res = NextResponse.redirect(sandboxAuthorizationUrl(redirectUri, `${SANDBOX_STATE_PREFIX}${nonce}`));
    res.cookies.set(SANDBOX_STATE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
    return res;
  } catch (err) {
    return NextResponse.redirect(
      `${origin}/dashboard/settings/payments?err=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
    );
  }
}
