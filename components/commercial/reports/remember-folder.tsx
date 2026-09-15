"use client";

import { useEffect } from "react";
import { FOLDER_COOKIE } from "@/lib/commercial/reports/access-rule";

/**
 * Remember the folder someone last opened on the Reports index.
 *
 * A cookie rather than localStorage so the SERVER renders the right folder on
 * the next visit — no flash of "All reports" before a client swap. Scoped to
 * /commercial; it holds a folder id or "all", nothing sensitive, and the server
 * re-validates it against the viewer's folders on every read.
 */
export function RememberReportFolder({ value }: { value: string }) {
  useEffect(() => {
    try {
      document.cookie = `${FOLDER_COOKIE}=${encodeURIComponent(value)}; path=/commercial; max-age=31536000; samesite=lax`;
    } catch {
      // Blocked cookies just mean the index opens on the default next time.
    }
  }, [value]);
  return null;
}
