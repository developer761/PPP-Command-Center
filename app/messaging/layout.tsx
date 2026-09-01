import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

/**
 * Messaging — a peer platform of PPP Command Center and Commercial, not a page
 * nested inside either. An admin who works in messaging all day should not be
 * two clicks deep.
 *
 * Gated twice, the same way /admin is: has_messaging_access decides who sees
 * the tile, and this layout re-checks server-side on every request. A hidden
 * tile is not an authorisation boundary.
 *
 * The chrome is deliberately thin. This surface is an inbox someone works from
 * a phone between jobs, so the header stays out of the way and the list gets
 * the screen.
 */
export default async function MessagingLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  if (profile && profile.is_active === false && !isAdminEmail(user.email)) {
    redirect("/?error=access_revoked");
  }
  const access = platformAccess(profile);
  if (!access.hasMessaging) {
    redirect(access.accessible.length > 0 ? "/choose-platform" : "/");
  }

  return (
    <div className="min-h-screen bg-ppp-charcoal-50">
      {/* Sticky so the identity of the surface survives a long scroll, which on
          a phone is the whole session. */}
      <header className="sticky top-0 z-20 bg-white border-b border-ppp-charcoal-100">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-7 w-7 shrink-0 rounded-lg bg-ppp-orange-50 text-ppp-orange-700 flex items-center justify-center">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </span>
            <span className="font-bold text-ppp-charcoal truncate">Messaging</span>
          </div>
          {/* 44px tap target on a phone, per iOS HIG — this is the only way out
              of the surface and it must not need a careful thumb. */}
          <Link
            href="/choose-platform"
            className="shrink-0 inline-flex items-center gap-1.5 min-h-[44px] sm:min-h-0 px-2 -mr-2 text-[13px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal rounded-lg touch-manipulation"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            <span className="hidden sm:inline">Switch</span>
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
