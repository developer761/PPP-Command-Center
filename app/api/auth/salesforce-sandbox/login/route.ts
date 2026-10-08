import { NextResponse } from "next/server";
import { getSignedInAdminEmail } from "@/lib/payments/access";
import { paymentsOrg, sandboxAuthorizationUrl } from "@/lib/salesforce/payments-org";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/salesforce-sandbox/login — connect the PAYMENTS code to a
 * Salesforce sandbox for testing. Stored apart from the production login, which
 * this never touches (see lib/salesforce/payments-org.ts). Admin only, and only
 * when the server runs with PAYMENTS_SF_ORG=sandbox.
 */
export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  if (!(await getSignedInAdminEmail())) return NextResponse.redirect(`${origin}/dashboard`);
  if (paymentsOrg() !== "sandbox") {
    return NextResponse.redirect(
      `${origin}/dashboard/settings/payments?err=${encodeURIComponent("Start the server with PAYMENTS_SF_ORG=sandbox to connect a sandbox.")}`,
    );
  }
  try {
    return NextResponse.redirect(sandboxAuthorizationUrl(`${origin}/api/auth/salesforce-sandbox/callback`));
  } catch (err) {
    return NextResponse.redirect(
      `${origin}/dashboard/settings/payments?err=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
    );
  }
}
