"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ModalPortal from "@/components/modal-portal";
import PlatformSwitcher from "@/components/platform-switcher";
import type { Platform } from "@/lib/platform-cookie";
import MessagingSidebar, { type SidebarWorkspace } from "./messaging-sidebar";
import { useScrollLock } from "@/lib/commercial/use-scroll-lock";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Two-pane shell: a fixed rail on desktop, an off-canvas drawer below lg.
 *
 * Hatch's rail is always there, which is fine on a laptop and unusable on a
 * phone — 330px of a 430px screen. Same content, same order, but on mobile it
 * slides over and the list keeps the full width.
 */
export default function MessagingChrome({
  workspaces,
  userInitial,
  accessible,
  children,
}: {
  workspaces: SidebarWorkspace[];
  userInitial: string;
  /** Every platform this viewer may open. Messaging is a peer of the two
   *  Command Centers, so it gets the SAME switcher they do — a text link to
   *  the picker was a dead end that made this surface feel like a silo. */
  accessible: Platform[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen bg-ppp-charcoal-50 lg:flex">
      {/* Desktop rail */}
      <aside className="hidden lg:flex lg:w-[268px] lg:shrink-0 lg:flex-col lg:h-screen lg:sticky lg:top-0 border-r border-ppp-charcoal-100">
        <MessagingSidebar workspaces={workspaces} />
        <UserFooter initial={userInitial} accessible={accessible} />
      </aside>

      {/* Mobile drawer */}
      {/* Portalled: a transformed ancestor makes `fixed` resolve against that
          ancestor rather than the viewport, so an un-portalled drawer opens
          off-screen once the page is scrolled. The repo has a test for this
          and it caught me. */}
      {open && (
        <ModalPortal>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="lg:hidden fixed inset-0 z-40 bg-ppp-charcoal/40 backdrop-blur-sm min-h-[44px] sm:min-h-0 touch-manipulation"
          />
          <Drawer onClose={() => setOpen(false)}>
            <MessagingSidebar workspaces={workspaces} onNavigate={() => setOpen(false)} />
            <UserFooter initial={userInitial} accessible={accessible} />
          </Drawer>
        </ModalPortal>
      )}

      <div className="flex-1 min-w-0">
        {/* Mobile top bar. The rail's identity has to live somewhere when the
            rail is not on screen, so the org name sits here instead. */}
        <header className="lg:hidden sticky top-0 z-30 bg-white border-b border-ppp-charcoal-100">
          <div className="px-2 h-14 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Open workspaces"
              className="h-11 w-11 shrink-0 flex items-center justify-center rounded-lg text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 touch-manipulation"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M3 6h18 M3 12h18 M3 18h18" />
              </svg>
            </button>
            <span className="font-bold text-ppp-charcoal truncate">Connect Hub</span>
            <Link
              href="/choose-platform"
              aria-label="Switch platform"
              className="ml-auto h-11 w-11 shrink-0 flex items-center justify-center rounded-lg text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 touch-manipulation"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
            </Link>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * The mobile drawer as a dialog.
 *
 * It was a bare <aside>: no Escape, no close button inside it, nothing to
 * tell a screen reader a dialog had opened, and Tab walked straight out into
 * the page hidden behind the backdrop. Focus goes in on open, stays in while
 * open, and returns to the menu button on close.
 */
function Drawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // Held in a ref so a parent re-render (a new arrow each time) does not
  // re-run the effect, which would bounce focus out and back in.
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useScrollLock(true);

  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    (focusables()[0] ?? panel).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close.current(); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) { e.preventDefault(); panel.focus(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);

  return (
    <aside ref={ref} role="dialog" aria-modal="true" aria-label="Workspaces" tabIndex={-1}
      className="lg:hidden fixed inset-y-0 left-0 z-50 w-[min(84vw,300px)] flex flex-col bg-white shadow-2xl focus:outline-none">
      {/* Over the sidebar's own 56px header, so the drawer keeps one header. */}
      <button type="button" onClick={onClose} aria-label="Close menu"
        className="absolute top-1.5 right-1.5 z-10 h-11 w-11 flex items-center justify-center rounded-lg bg-white text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 touch-manipulation">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
          <path d="M18 6L6 18 M6 6l12 12" />
        </svg>
      </button>
      {children}
    </aside>
  );
}

function UserFooter({ initial, accessible }: { initial: string; accessible: Platform[] }) {
  return (
    <div className="shrink-0 border-t border-ppp-charcoal-100 bg-white p-2.5 space-y-2 pb-safe-sm">
      {/* The same switcher the Command Centers carry, rendering one button per
          platform this person can actually open. */}
      <PlatformSwitcher current="messaging" accessible={accessible} />
      <div className="flex items-center gap-2 px-0.5">
        <span className="h-7 w-7 shrink-0 rounded-full bg-ppp-charcoal text-white text-[11px] font-bold flex items-center justify-center">
          {initial}
        </span>
        <span className="text-[12px] text-ppp-charcoal-500 truncate">Signed in</span>
      </div>
    </div>
  );
}
