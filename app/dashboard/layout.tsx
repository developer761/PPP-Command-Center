import { redirect } from "next/navigation";
import DashboardChrome from "@/components/dashboard-chrome";
import { createClient } from "@/lib/supabase/server";

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
  if (!user || !user.email?.toLowerCase().endsWith("@precisionpaintingplus.net")) {
    redirect("/");
  }

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const fullName =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    null;
  const firstName = fullName ? fullName.split(" ")[0] : null;
  const initial = (firstName ?? user.email[0] ?? "P").charAt(0).toUpperCase();

  return (
    <DashboardChrome
      user={{
        email: user.email,
        fullName,
        firstName,
        initial,
      }}
    >
      {children}
    </DashboardChrome>
  );
}
