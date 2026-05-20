import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next.js 16 renamed `middleware` → `proxy`. The function export is now `proxy`,
// not `middleware`. The internal helper `updateSession` (in lib/supabase/middleware.ts)
// is unrelated to Next's naming — it just refreshes Supabase Auth's session cookie.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static assets)
     * - _next/image (image optimization)
     * - favicon.ico
     * - Public files in /brand
     * - /api/auth/* (auth flows handle their own cookie writes; running the proxy
     *   on them risks clobbering Set-Cookie headers from the callback responses)
     */
    "/((?!_next/static|_next/image|favicon.ico|brand/|api/auth/).*)",
  ],
};
