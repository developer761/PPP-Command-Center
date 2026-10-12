import { finishSandboxSignIn } from "@/lib/salesforce/sandbox-callback";

export const dynamic = "force-dynamic";

/** Sandbox OAuth callback, for a Connected App that lists this URL. */
export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  return finishSandboxSignIn(request, `${origin}/api/auth/salesforce-sandbox/callback`);
}
