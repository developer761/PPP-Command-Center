"use client";

import { useEffect } from "react";

/**
 * Registers the service worker after the page is interactive.
 *
 * Deferred to `load` on purpose: registration competes for bandwidth with the
 * page itself, and on the slow connections this exists to survive, racing the
 * first paint is the wrong trade.
 *
 * Failure is silent by design — a browser with workers disabled, or a private
 * window, should get an app that simply isn't installable rather than a console
 * full of errors or, worse, a visible warning a crew can't act on.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    // Dev builds recompile constantly; a worker caching that output causes
    // stale-page confusion that looks like a bug in the app.
    if (process.env.NODE_ENV !== "production") return;

    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* not installable here — nothing the user can do about it */
      });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
