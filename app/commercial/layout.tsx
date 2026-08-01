import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isAllowedToSignIn, isAdminEmail } from "@/lib/auth/admin";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import CommercialChrome from "@/components/commercial-chrome";
import { UndoToast } from "@/components/commercial/undo-toast";
import { CommandPalette } from "@/components/commercial/command-palette";
import { KeyboardShortcuts } from "@/components/commercial/keyboard-shortcuts";
import { Suspense } from "react";

/**
 * /commercial — New Platform layout.
 *
 * Gated end-to-end:
 *   - No session → /
 *   - Not on domain allow-list → /
 *   - No New Platform access flag → /dashboard (back to Command Center)
 *
 * The chrome itself is its own component so the topbar + sidebar shells
 * stay strictly separate from the residential `/dashboard/*` chrome —
 * required by the platform-separation rule.
 */
export default async function CommercialDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/");
  }

  const profile = await getProfileByUserId(user.id);
  // Two ways in (mirror the dashboard layout so the gates agree):
  //   1. SSO staff on a PPP domain / admin allow-list (isAllowedToSignIn)
  //   2. An admin-provisioned email+password account (has a profile row) — e.g.
  //      the Tomco testers on @tomcopainting.com, who are NOT on the SSO
  //      allow-list. Before this exemption they were bounced /commercial → /,
  //      which loops for a commercial-only account. Provisioned users pass.
  const provisioned = !!profile;
  if (!isAllowedToSignIn(user.email) && !provisioned) {
    redirect("/");
  }
  // Deactivation is authoritative — locked out on the next request (admins
  // exempt so the platform can't be bricked). Mirrors the dashboard gate.
  if (profile && profile.is_active === false && !isAdminEmail(user.email)) {
    redirect("/?error=access_revoked");
  }

  const access = platformAccess(profile);
  if (!access.hasNewPlatform) {
    redirect("/dashboard"); // they don't have access — bounce to the platform they DO have
  }

  const email = user.email!;
  const fullName = profile?.sf_user_name ?? email.split("@")[0];
  const firstName = fullName.split(" ")[0] ?? null;
  const initial = (firstName ?? email[0] ?? "P").charAt(0).toUpperCase();
  // Platform admin — gates the admin-only "Access" nav item. The Access page
  // itself re-checks via normalizeRole (authoritative); this just hides the link.
  const isAdmin = profile?.is_admin === true || isAdminEmail(user.email);

  // Phase I — dark mode. Read the persisted theme so the server renders the
  // right one (no flash on navigation). Scoped to this wrapper, so the
  // residential Command Center is never affected.
  const theme = (await cookies()).get("cc-theme")?.value === "dark" ? "dark" : "light";

  return (
    <div className="cc-theme-root" data-cc-root data-theme={theme}>
    <CommercialChrome
      user={{ email, fullName, firstName, initial }}
      showSwitcher={access.hasBoth}
      isAdmin={isAdmin}
    >
      {children}
      {/* Karan 2026-07-11 (signature-moments batch): global undo-toast.
          Renders when a URL has ?undo_id=<uuid>&undo_kind=deal|note|
          invoice — soft-delete server actions redirect with those
          params so accidental deletes have a 5-second Undo. Wrapped
          in Suspense because useSearchParams requires it. */}
      <Suspense fallback={null}>
        <UndoToast />
      </Suspense>
      {/* Karan 2026-07-11 signature-moments Tier 2: ⌘K / Ctrl+K
          command palette. Global search across accounts + deals +
          invoices, with keyboard-only navigation. */}
      <CommandPalette />
      {/* Karan 2026-07-11 signature-moments Tier 3: global keyboard
          shortcuts — /, N, G+P/A/I/D, ? for help. Bridges into
          CommandPalette via a custom event so both live in the same
          layer. */}
      <KeyboardShortcuts />
    </CommercialChrome>
    </div>
  );
}
