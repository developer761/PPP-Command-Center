"use client";

import { useState } from "react";
import Link from "next/link";
import ModalPortal from "@/components/modal-portal";
import MessagingSidebar, { type SidebarWorkspace } from "./messaging-sidebar";

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
  children,
}: {
  workspaces: SidebarWorkspace[];
  userInitial: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen bg-ppp-charcoal-50 lg:flex">
      {/* Desktop rail */}
      <aside className="hidden lg:flex lg:w-[268px] lg:shrink-0 lg:flex-col lg:h-screen lg:sticky lg:top-0 border-r border-ppp-charcoal-100">
        <MessagingSidebar workspaces={workspaces} />
        <UserFooter initial={userInitial} />
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
            className="lg:hidden fixed inset-0 z-40 bg-ppp-charcoal/40 backdrop-blur-sm"
          />
          <aside className="lg:hidden fixed inset-y-0 left-0 z-50 w-[min(84vw,300px)] flex flex-col shadow-2xl">
            <MessagingSidebar workspaces={workspaces} onNavigate={() => setOpen(false)} />
            <UserFooter initial={userInitial} />
          </aside>
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
            <span className="font-bold text-ppp-charcoal truncate">Messaging</span>
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

function UserFooter({ initial }: { initial: string }) {
  return (
    <div className="shrink-0 border-t border-ppp-charcoal-100 bg-white px-3 py-2.5 flex items-center gap-2 pb-safe-sm">
      <span className="h-8 w-8 shrink-0 rounded-full bg-ppp-charcoal text-white text-[12px] font-bold flex items-center justify-center">
        {initial}
      </span>
      <Link
        href="/choose-platform"
        className="ml-auto inline-flex items-center gap-1.5 min-h-[40px] px-2 rounded-lg text-[12px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50 touch-manipulation"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
        Switch
      </Link>
    </div>
  );
}
