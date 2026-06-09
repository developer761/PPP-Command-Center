"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Props = {
  name: string | null;
  email: string;
  initial: string;
};

export default function UserMenu({ name, email, initial }: Props) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const signOut = async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`User menu for ${name ?? email}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={[
          "h-11 w-11 sm:h-9 sm:w-9 rounded-full bg-ppp-blue text-white flex items-center justify-center font-semibold text-sm shadow-sm shadow-ppp-blue/30",
          "hover:ring-2 hover:ring-ppp-blue/20 transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-ppp-blue/40",
        ].join(" ")}
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 z-40 w-64 rounded-lg bg-white border border-ppp-charcoal-100 shadow-xl shadow-ppp-charcoal/15 py-1 animate-fade-in"
        >
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            {name && (
              <div className="text-sm font-semibold text-ppp-navy truncate">
                {name}
              </div>
            )}
            <div className="text-xs text-ppp-charcoal-500 truncate">{email}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            disabled={signingOut}
            className="w-full text-left px-4 py-2.5 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 disabled:opacity-60 transition-colors flex items-center gap-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9" />
            </svg>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
