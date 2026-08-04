import "server-only";

import DOMPurify from "isomorphic-dompurify";

/**
 * DOMPurify-grade HTML sanitizer for archived emails (R8 hardening).
 *
 * Upgraded from the previous regex stripper — regex can't defend mutation-XSS
 * (parser-confusion tricks that re-form a dangerous node after a naive strip),
 * DOM clobbering, or SVG/namespace abuse. DOMPurify parses the HTML into a real
 * DOM and re-serializes an allow-listed subset, which closes those whole
 * classes. Runs server-side only (ingest webhook + the server-rendered Email
 * Archive tab) via isomorphic-dompurify's jsdom backend, so nothing ships to
 * the browser.
 *
 * Policy — keep an email looking like an email, kill everything executable:
 *   - Drop <script>, <style>, <iframe>, <object>, <embed>, <form> + controls,
 *     <link>, <meta>, <base> (DOMPurify's default plus explicit FORBID_TAGS).
 *   - Drop on-* handlers, inline style="…", srcset, and any data-* attribute.
 *   - Block javascript:/vbscript:/data:text-html URLs (DOMPurify default);
 *     data:image and normal http(s)/mailto/tel links are preserved.
 *   - Force every link to open safely: target=_blank + rel=noopener noreferrer
 *     (no reverse-tabnabbing), added once via a hook below.
 *   - No SVG/MathML profile (svg can smuggle script through <foreignObject>).
 */

// Register the link-hardening hook ONCE at module load. Registering it inside
// sanitizeEmailHtml would stack a new hook on every call.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  // `node` is a DOM element; guard for the anchor case.
  const el = node as unknown as { tagName?: string; hasAttribute?: (n: string) => boolean; setAttribute?: (n: string, v: string) => void };
  if (el.tagName === "A" && el.hasAttribute?.("href")) {
    el.setAttribute?.("target", "_blank");
    el.setAttribute?.("rel", "noopener noreferrer");
  }
});

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true as const }, // HTML only — no SVG/MathML
  FORBID_TAGS: [
    "style",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "iframe",
    "object",
    "embed",
    "link",
    "meta",
    "base",
  ],
  FORBID_ATTR: ["style", "srcset"],
  ALLOW_DATA_ATTR: false,
};

/**
 * Sanitize an HTML email body to a safe, still-styled-enough subset.
 * Returns "" for falsy input. Idempotent (re-sanitizing is a no-op).
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** Plain-text fallback when no `text` body was provided. Strips HTML
 *  to extract a best-effort readable string. Conservative — drops
 *  everything inside angle brackets, decodes a few common entities,
 *  collapses whitespace. Used only when Resend didn't include a text
 *  body (rare). */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    // Drop script/style content entirely
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    // Convert <br>, </p>, </div> to newlines for readability
    .replace(/<\s*\/(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    // Strip the rest
    .replace(/<[^>]+>/g, "")
    // Decode common entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse runs of whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
