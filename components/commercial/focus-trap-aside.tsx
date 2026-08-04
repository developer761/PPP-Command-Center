"use client";

/**
 * R8 accessibility — a focus-trapped slide-out panel.
 *
 * Drop-in replacement for the `<aside>` element of the commercial URL-driven
 * slide-out sheets (New opportunity, invoice edit, deal edit). Adds proper
 * dialog semantics + keyboard accessibility that the server-rendered `<aside>`
 * couldn't:
 *   - moves focus into the panel on open, restores it to the trigger on close,
 *   - traps Tab / Shift+Tab within the panel,
 *   - Esc navigates to `closeHref` (same as clicking the backdrop / ✕).
 *
 * Server-rendered content (forms with server actions, pickers) is passed as
 * children untouched — this only wraps them in an accessible dialog shell.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function FocusTrapAside({
  closeHref,
  className,
  id,
  ariaLabel,
  ariaLabelledBy,
  children,
}: {
  closeHref: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const router = useRouter();

  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const prevActive = document.activeElement as HTMLElement | null;

    const visibleFocusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );

    // Move focus into the panel (first field, else the panel itself).
    const first = visibleFocusables()[0];
    (first ?? panel).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        router.push(closeHref);
        return;
      }
      if (e.key !== "Tab") return;
      const f = visibleFocusables();
      if (f.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = f[0];
      const lastEl = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || active === panel)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    panel.addEventListener("keydown", onKey);
    return () => {
      panel.removeEventListener("keydown", onKey);
      // Restore focus to whatever opened the sheet (if still in the document).
      if (prevActive && document.contains(prevActive)) prevActive.focus();
    };
  }, [closeHref, router]);

  return (
    <aside
      ref={ref}
      id={id}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={className}
    >
      {children}
    </aside>
  );
}
