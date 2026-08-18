"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import CommercialSidebar from "@/components/commercial-sidebar";
import CommercialTopbar from "@/components/commercial-topbar";
import ActionRequiredBar from "@/components/commercial/action-required-bar";
import { useScrollLock } from "@/lib/commercial/use-scroll-lock";

/**
 * Chrome wrapper for `/commercial/*` — sibling to dashboard-chrome.tsx.
 *
 * Distinct from the Command Center chrome on purpose (platform separation):
 * different sidebar, different topbar variant, no SF ViewerProvider (the
 * New Platform doesn't have a SF-snapshot viewer concept; its own RBAC
 * primitive lives in lib/commercial/rbac.ts and is read per-page).
 */

type Props = {
  children: React.ReactNode;
  user: {
    email: string;
    fullName: string | null;
    firstName: string | null;
    initial: string;
  };
  showSwitcher: boolean;
  /** Platform admin — gates admin-only sidebar items (Access). */
  isAdmin: boolean;
  /** Crew-only login — collapses the nav to the crew surfaces. */
  crewOnly?: boolean;
};

export default function CommercialChrome({ children, user, showSwitcher, isAdmin, crewOnly = false }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setMobileOpen(false), [pathname]);

  // `document.body.style.overflow = "hidden"` does NOTHING here: the scroller
  // in this shell is <main className="flex-1 overflow-y-auto">, not <body>. So
  // the drawer opened and the page kept scrolling behind it on every Commercial
  // page — on the phone the CEO reads this on. useScrollLock targets the real
  // scroller (that's why it exists).
  useScrollLock(mobileOpen);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="flex min-h-screen bg-[var(--color-surface-muted)]">
      <aside className="hidden lg:block shrink-0">
        <CommercialSidebar showSwitcher={showSwitcher} isAdmin={isAdmin} crewOnly={crewOnly} />
      </aside>

      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-ppp-charcoal/40 backdrop-blur-sm animate-fade-in"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={[
          "lg:hidden fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] shadow-2xl shadow-ppp-charcoal/20",
          "transform transition-transform duration-200 ease-out",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
        aria-hidden={!mobileOpen}
        aria-modal={mobileOpen}
        role={mobileOpen ? "dialog" : undefined}
        // inert when closed so the off-screen nav links drop out of the tab
        // order too (aria-hidden alone leaves them keyboard-focusable — 2026-08
        // a11y walk).
        inert={!mobileOpen}
      >
        <CommercialSidebar showSwitcher={showSwitcher} isAdmin={isAdmin} crewOnly={crewOnly} onNavigate={() => setMobileOpen(false)} />
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <CommercialTopbar user={user} onOpenMenu={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-y-auto">
          {/* Sticky above the page content, inside the scroller so it pins as
              you scroll. Crew logins never see it — approvals aren't theirs. */}
          {!crewOnly && <ActionRequiredBar />}
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
