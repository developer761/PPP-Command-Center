"use client";

import { useEffect } from "react";

/**
 * Keyboard-accessibility hook for modals — closes on Escape key.
 *
 * Usage:
 *   useEscClose(() => setOpen(false), { enabled: isOpen, allowDuring: !saving });
 *
 * The `allowDuring` guard is useful when the modal is mid-send and
 * dismissing it would lose state (e.g., between Resend send + DB
 * confirmation). When `allowDuring=false` the Esc keypress is a no-op
 * so the customer / admin can't accidentally cancel mid-operation.
 */
export function useEscClose(
  onClose: () => void,
  options: { enabled?: boolean; allowDuring?: boolean } = {}
) {
  const { enabled = true, allowDuring = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!allowDuring) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, allowDuring, onClose]);
}
