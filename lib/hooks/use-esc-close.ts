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
 *
 * STACK SEMANTICS: when modals nest (e.g., a SupplierPickerModal opened
 * inside a DraftOrderModal), Esc should close ONLY the topmost modal,
 * not collapse the whole stack. We track the most-recent subscriber in
 * a module-level registry and only fire its handler. Previously both
 * handlers ran on a single Esc keypress, dismissing both modals.
 */

// Subscribers are pushed on mount and popped on unmount. The LAST one in
// the array is the topmost modal — the one Esc should target.
const subscribers: Array<{ onClose: () => void; allowDuring: boolean }> = [];

let listenerInstalled = false;
function ensureListener() {
  if (listenerInstalled || typeof window === "undefined") return;
  listenerInstalled = true;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const top = subscribers[subscribers.length - 1];
    if (!top || !top.allowDuring) return;
    e.preventDefault();
    e.stopPropagation();
    top.onClose();
  });
}

export function useEscClose(
  onClose: () => void,
  options: { enabled?: boolean; allowDuring?: boolean } = {}
) {
  const { enabled = true, allowDuring = true } = options;
  useEffect(() => {
    if (!enabled) return;
    ensureListener();
    const entry = { onClose, allowDuring };
    subscribers.push(entry);
    return () => {
      const idx = subscribers.lastIndexOf(entry);
      if (idx >= 0) subscribers.splice(idx, 1);
    };
  }, [enabled, allowDuring, onClose]);
}
