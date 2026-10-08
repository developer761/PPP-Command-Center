import "server-only";

import { NextResponse } from "next/server";
import { getSignedInAdminEmail } from "@/lib/payments/access";
import { connectSandbox, paymentsOrg } from "@/lib/salesforce/payments-org";

/**
 * Finish the PAYMENTS sandbox sign-in.
 *
 * Shared by /api/auth/salesforce-sandbox/callback and — because the sandbox's
 * copy of the Connected App only allows the callback URLs registered in
 * production — the app-wide /api/auth/salesforce/callback, which hands off
 * here ONLY when the OAuth `state` is ours ("payments-sandbox.<nonce>").
 * That route's production path is never reached for a sandbox sign-in, and
 * this path refuses unless:
 *   - the nonce matches the httpOnly cookie set when the sign-in started,
 *   - the server runs in sandbox mode (PAYMENTS_SF_ORG=sandbox), and
 *   - Salesforce returns a sandbox instance (connectSandbox checks).
 * The production Salesforce login is never read or written here.
 */
export const SANDBOX_STATE_PREFIX = "payments-sandbox.";
export const SANDBOX_STATE_COOKIE = "ppp_sf_sandbox_state";

export async function finishSandboxSignIn(request: Request, redirectUri: string): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const back = (k: "ok" | "err", m: string) => {
    const res = NextResponse.redirect(`${origin}/dashboard/settings/payments?${k}=${encodeURIComponent(m)}`);
    res.cookies.delete(SANDBOX_STATE_COOKIE);
    return res;
  };
  const email = await getSignedInAdminEmail();
  if (!email) return NextResponse.redirect(`${origin}/dashboard`);
  if (paymentsOrg() !== "sandbox") return back("err", "Not in sandbox mode (PAYMENTS_SF_ORG=sandbox) — nothing stored.");

  const state = searchParams.get("state") ?? "";
  const cookie = request.headers.get("cookie")?.match(new RegExp(`${SANDBOX_STATE_COOKIE}=([^;]+)`))?.[1];
  if (!state.startsWith(SANDBOX_STATE_PREFIX) || !cookie || state.slice(SANDBOX_STATE_PREFIX.length) !== cookie) {
    return back("err", "That sandbox sign-in didn't start here (state mismatch) — nothing stored. Start again from Settings → Online Payments.");
  }
  const err = searchParams.get("error");
  if (err) return back("err", `Salesforce said: ${searchParams.get("error_description") ?? err}`);
  const code = searchParams.get("code");
  if (!code) return back("err", "No authorization code came back from Salesforce.");
  try {
    const instance = await connectSandbox(code, redirectUri, email);
    return back("ok", `Payments are connected to the sandbox: ${instance}`);
  } catch (e) {
    console.error("[sf-sandbox-callback]", e);
    return back("err", e instanceof Error ? e.message : String(e));
  }
}
