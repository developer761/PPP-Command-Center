import { redirect } from "next/navigation";
import DashboardChrome from "@/components/dashboard-chrome";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware should have caught this already; this is defense-in-depth.
  if (!user || !user.email?.toLowerCase().endsWith("@precisionpaintingplus.net")) {
    redirect("/");
  }

  // Derive a friendly display name from Google's profile metadata.
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
