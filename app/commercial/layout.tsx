import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isAllowedToSignIn, isAdminEmail } from "@/lib/auth/admin";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import CommercialChrome from "@/components/commercial-chrome";
import { isCrewOnlyUser, isCrewAllowedPath, CREW_HOME } from "@/lib/commercial/crew-access";
import { UndoToast } from "@/components/commercial/undo-toast";
import { CommandPalette } from "@/components/commercial/command-palette";
import { KeyboardShortcuts } from "@/components/commercial/keyboard-shortcuts";
import { OnboardingWalkthrough } from "@/components/commercial/onboarding-walkthrough";
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

  // CREW ROLE — default-deny gate (Karan 2026-08).
  //
  // A crew login may reach only an allowlist of field-ops surfaces; everything
  // else redirects to their home. Enforced HERE, in the layout every
  // /commercial/* page renders through, rather than as per-query filters:
  // Commercial access has been binary until now, so retro-fitting "except
  // crew" into a few hundred queries is how you end up silently serving a
  // painter the company P&L. Deny-by-default means a route added tomorrow is
  // safe without anyone remembering this rule.
  //
  // Note this cannot rely on the request path being available in a layout, so
  // the check reads the pathname the middleware stamps on the request headers.
  const crewOnly = await isCrewOnlyUser(user.id);
  if (crewOnly) {
    const pathname = (await headers()).get("x-pathname") ?? "";
    // No pathname header (an unexpected runtime) → send them home rather than
    // fall through to an unrestricted render. Failing closed is the whole point.
    if (!pathname || !isCrewAllowedPath(pathname)) redirect(CREW_HOME);
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
      crewOnly={crewOnly}
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
      {/* Search + shortcuts target routes a crew login can't reach — the API
          403s and the palette swallows it, so crew got a search box that
          silently returned nothing for every query. */}
      {!crewOnly && <CommandPalette />}
      {/* Karan 2026-07-11 signature-moments Tier 3: global keyboard
          shortcuts — /, N, G+P/A/I/D, ? for help. Bridges into
          CommandPalette via a custom event so both live in the same
          layer. */}
      {!crewOnly && <KeyboardShortcuts />}
      {/* R7 — onboarding guided tour. Always mounted so a "Take the tour" button
          can replay it any time; it AUTO-shows only for first-timers (NULL flag),
          then stamps itself so it never auto-opens again. */}
      <OnboardingWalkthrough
        firstName={firstName}
        autoStart={profile?.commercial_onboarding_seen_at == null}
      />
    </CommercialChrome>
    </div>
  );
}
