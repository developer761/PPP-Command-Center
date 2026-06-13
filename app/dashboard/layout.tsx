import { redirect } from "next/navigation";
import DashboardChrome from "@/components/dashboard-chrome";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail, isAllowedToSignIn } from "@/lib/auth/admin";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // PERF: this layout used to await loadDashboardData() to build a search
  // index. That blocked the chrome (sidebar + topbar) from rendering until
  // the entire SF snapshot was fetched — 10-15s on cold cache. Now the
  // search bar lazy-fetches its index from /api/search/index on first
  // focus, so the chrome renders instantly.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware should have caught this already; this is defense-in-depth.
  if (!user || !isAllowedToSignIn(user.email)) {
    redirect("/");
  }

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const fullNameFromGoogle =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    null;
  const email = user.email!; // guaranteed by isAllowedToSignIn check above

  // Profile drives the admin flag in the chrome (controls visibility of the
  // View Switcher). The full Viewer (with scope/view_as from URL params) is
  // resolved per-page since the layout doesn't see searchParams.
  const profile = await getProfileByUserId(user.id);

  // Name-resolution fallback chain — fixes the "Good afternoon, Precision"
  // bug where shared workspace inboxes (developer@precisionpaintingplus.net)
  // have a generic Google display name like "Precision Painting" → first
  // word "Precision" → greeting reads like the company is talking to itself.
  //
  // Priority:
  //   1. Mapped Salesforce user's name (the ACTUAL person behind this login)
  //   2. Google display name, ONLY if it doesn't look like the company name
  //   3. Email-handle-to-name (jane.doe@x.com → "Jane", k.sutton → "Kate")
  //   4. null → topbar drops the comma and just shows "Good afternoon"
  const GENERIC_WORKSPACE_TOKENS = ["precision", "ppp", "developer", "admin", "team", "test", "dev", "info"];
  function looksLikeWorkspaceName(s: string | null): boolean {
    if (!s) return true;
    const w = s.trim().toLowerCase().split(/\s+/);
    if (w.length === 0) return true;
    return GENERIC_WORKSPACE_TOKENS.includes(w[0]);
  }
  function nameFromEmail(em: string): string | null {
    // Map common patterns: first.last → "First", f.last → expand via known
    // PPP shortlist where possible (Kate, Katie, Alex), else capitalize the
    // leading letters.
    const handle = em.split("@")[0].toLowerCase();
    // Skip generic mailbox names — those are NOT a person.
    if (GENERIC_WORKSPACE_TOKENS.includes(handle)) return null;
    // Initial-dot-lastname pattern (k.sutton, j.kelly, a.solomon) — PPP's
    // convention. Use the part BEFORE the dot, capitalized.
    const m = handle.match(/^([a-z]+)\.([a-z]+)$/);
    if (m) {
      // For single-letter initials, fall back to the local-part as-is
      // (don't try to expand "k" → "Kate"; we don't know).
      return m[1].length > 1
        ? m[1].charAt(0).toUpperCase() + m[1].slice(1)
        : null;
    }
    // Plain firstname (karan, alex, sean) → capitalize
    const onlyName = handle.match(/^([a-z]+)$/);
    if (onlyName) {
      return onlyName[1].charAt(0).toUpperCase() + onlyName[1].slice(1);
    }
    return null;
  }

  // Resolve the display name in priority order.
  let firstName: string | null = null;
  let fullName: string | null = null;
  if (profile?.sf_user_name) {
    fullName = profile.sf_user_name;
    firstName = profile.sf_user_name.split(" ")[0];
  } else if (fullNameFromGoogle && !looksLikeWorkspaceName(fullNameFromGoogle)) {
    fullName = fullNameFromGoogle;
    firstName = fullNameFromGoogle.split(" ")[0];
  } else {
    firstName = nameFromEmail(email);
    fullName = firstName;
  }

  const initial = (firstName ?? email[0] ?? "P").charAt(0).toUpperCase();

  // Defense-in-depth: if the profile row is missing (DB blip, first-login
  // race before /auth/callback finishes), fall back to the env admin list so
  // a real admin doesn't lose the View Switcher and re-fetch in a hot loop.
  const isAdmin = profile?.is_admin ?? isAdminEmail(email);

  // Phase 0 New Platform — show the bottom-left sidebar switcher when the
  // viewer has access to both platforms. Single-access users never see it
  // (don't show what they can't use).
  const access = platformAccess(profile);

  // Cross-platform access gate: a user with ONLY New Platform access who
  // manually types /dashboard or follows a stale link is bounced to their
  // actual platform. A user with neither is sent through the picker (which
  // also bounces them out — the no-access page).
  if (!access.hasCommandCenter) {
    if (access.hasNewPlatform) redirect("/commercial");
    redirect("/choose-platform");
  }

  return (
    <DashboardChrome
      user={{
        email,
        fullName,
        firstName,
        initial,
      }}
      profile={{
        isAdmin,
        sfUserId: profile?.sf_user_id ?? null,
        sfUserName: profile?.sf_user_name ?? null,
      }}
      showPlatformSwitcher={access.hasBoth}
    >
      {children}
    </DashboardChrome>
  );
}
