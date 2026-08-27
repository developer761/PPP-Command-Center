"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A visible way to install the Command Center, instead of hunting a browser menu.
 *
 * Everything needed to install has been in place for a while — manifest, icons,
 * service worker, HTTPS — but the only way to actually do it was Chrome's ⋮ menu
 * or Safari's Share sheet. That is fine for someone who knows PWAs exist and
 * hopeless for a crew who does not. This surfaces the one action.
 *
 * THE TWO PLATFORMS BEHAVE COMPLETELY DIFFERENTLY.
 *
 * Android/Chrome fires `beforeinstallprompt`, which can be captured and replayed
 * later from a real button — so there the install is one tap and the browser
 * shows its own confirmation sheet.
 *
 * iOS Safari fires nothing and exposes no install API at all. Apple only allows
 * it through Share → Add to Home Screen, so the honest thing is to show that
 * instruction rather than a button that cannot work. Detected by the ABSENCE of
 * the event plus an iOS user agent, never by pretending the button exists.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "ppp.install.dismissed";

/** Already running as an installed app — nothing to offer. */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS predates the display-mode media query and uses its own flag.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export default function InstallAppPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);   // assume hidden until checked
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch { /* private mode — show it, worst case they dismiss again */ }
    setDismissed(false);

    const onPrompt = (e: Event) => {
      // Chrome shows its own mini-infobar unless this is prevented; suppressing
      // it lets the app choose a moment and a wording that fits the workflow.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => { setDeferred(null); setDismissed(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // iOS never fires the event, so the instruction path is decided on a timer
    // rather than immediately — otherwise an Android device would flash the
    // iOS wording in the moment before Chrome gets around to firing.
    const t = window.setTimeout(() => {
      if (isIos()) setShowIosHint(true);
    }, 1200);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.clearTimeout(t);
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* nothing to do */ }
  }, []);

  const install = async () => {
    if (!deferred) return;
    setInstalling(true);
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      // The captured event is single-use whatever the answer; a second prompt()
      // throws. Declining also means not asking again on every page.
      setDeferred(null);
      if (outcome === "dismissed") dismiss();
    } catch {
      setDeferred(null);
    } finally {
      setInstalling(false);
    }
  };

  if (dismissed) return null;
  if (!deferred && !showIosHint) return null;

  return (
    <div
      // z-40 deliberately: above ordinary page chrome and sticky bars (z-30),
      // BELOW every full-screen overlay (modals z-50, measure z-60, settings
      // sheet z-70). At z-80 this banner would have sat on top of the measure
      // tool's capture button — an install nag covering the reason the app was
      // opened.
      className="fixed inset-x-0 bottom-0 z-40 px-3 pt-3 pointer-events-none"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="pointer-events-auto mx-auto max-w-md rounded-2xl bg-ppp-navy text-white shadow-2xl shadow-ppp-charcoal/40 px-4 py-3 flex items-start gap-3">
        <span aria-hidden className="text-2xl leading-none mt-0.5">📲</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Put this on your home screen</p>
          <p className="text-[12px] text-white/70 leading-snug mt-0.5">
            {deferred
              ? "Opens full screen, no address bar, and starts on your work orders."
              : "Tap Share, then “Add to Home Screen”."}
          </p>
          {deferred && (
            <button
              type="button" onClick={install} disabled={installing}
              className="mt-2 min-h-[44px] w-full rounded-xl bg-ppp-blue text-ppp-navy text-sm font-bold disabled:opacity-60 touch-manipulation"
            >
              {installing ? "Opening…" : "Install"}
            </button>
          )}
        </div>
        <button
          type="button" onClick={dismiss} aria-label="Not now"
          className="shrink-0 h-11 w-11 rounded-lg text-white/60 hover:bg-white/10 text-lg touch-manipulation"
        >✕</button>
      </div>
    </div>
  );
}
