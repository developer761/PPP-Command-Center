import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Proxy (Next 16's rename of Middleware — same thing).
 *
 * Sole job: stamp the request path onto a header so server layouts can read
 * it. A layout has no access to the URL, and the Crew-role gate in
 * app/commercial/layout.tsx needs to know which route is being rendered so it
 * can deny anything outside the crew allowlist.
 *
 * The AUTH decision deliberately stays in the layout, not here. Next's own
 * guidance is that proxy is for optimistic checks, not authorization — it
 * can't safely do session lookups, and putting the real gate here would mean
 * the layout trusts a header it can't verify. This only reports where the
 * request is going; whether that's allowed is decided server-side with the
 * session in hand.
 *
 * Header hygiene: `x-pathname` is stripped from the INCOMING request before
 * being re-set, so a client can't forge it to slip past the crew allowlist.
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("x-pathname");
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Only the Commercial platform needs this today; keeping the matcher narrow
  // means no per-request work anywhere else.
  matcher: "/commercial/:path*",
};
