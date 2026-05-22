import { redirect } from "next/navigation";
import DashboardChrome from "@/components/dashboard-chrome";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail, isAllowedToSignIn } from "@/lib/auth/admin";
import { getProfileByUserId } from "@/lib/auth/profile";

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
  const fullName =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    null;
  const firstName = fullName ? fullName.split(" ")[0] : null;
  const email = user.email!; // guaranteed by isAllowedToSignIn check above
  const initial = (firstName ?? email[0] ?? "P").charAt(0).toUpperCase();

  // Profile drives the admin flag in the chrome (controls visibility of the
  // View Switcher). The full Viewer (with scope/view_as from URL params) is
  // resolved per-page since the layout doesn't see searchParams.
  const profile = await getProfileByUserId(user.id);

  // Defense-in-depth: if the profile row is missing (DB blip, first-login
  // race before /auth/callback finishes), fall back to the env admin list so
  // a real admin doesn't lose the View Switcher and re-fetch in a hot loop.
  const isAdmin = profile?.is_admin ?? isAdminEmail(email);

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
    >
      {children}
    </DashboardChrome>
  );
}
