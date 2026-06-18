import "server-only";

/**
 * Focused HTML sanitizer for archived emails.
 *
 * Why not isomorphic-dompurify? Stage 2 is internal-only — the team
 * sees emails, customers don't. Default render is plain-text; "Show
 * HTML" is opt-in. The attack surface is "Alex clicks Show HTML on
 * an email from a malicious GC trying to phish the team." That's a
 * real risk worth defending, but the full dompurify dependency
 * (~30KB + indirect deps) is overkill for the actual exposure.
 *
 * Strategy — kill the high-risk vectors:
 *   1. Drop <script>, <style>, <iframe>, <object>, <embed>, <link>,
 *      <meta>, <base>, <form>, <input>, <button>, <textarea>, <select>,
 *      <math>, <svg> (svg can carry script via <foreignObject>).
 *   2. Strip on-* attributes (onclick, onload, onerror, onmouseover, …).
 *   3. Neutralize javascript:/data:/vbscript: URLs in href + src.
 *   4. Drop srcset (avoids tracker pings).
 *   5. Leave text formatting (<p>, <br>, <strong>, <em>, <a>, <img>,
 *      <table>, <ul>/<ol>, etc.) alone so the email still looks like
 *      an email.
 *
 * NOT a full sanitizer. Doesn't handle:
 *   - Mutation XSS (nesting tricks that survive simple regex strip)
 *   - DOM clobbering
 *   - SVG-embedded JS with namespace abuse
 *   - CSS expression() / -moz-binding in style attributes
 *
 * Acceptable risk because (a) plain-text default, (b) internal team
 * audience, (c) Resend already strips some of this server-side. If
 * Stage 2 ever surfaces archived emails to customers, upgrade to
 * dompurify-equivalent.
 */

const DANGEROUS_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "math",
  "svg",
];

const DANGEROUS_URL_PROTOCOLS = /^(javascript|data|vbscript|file):/i;

/**
 * Strip dangerous content from an HTML email body. Returns the
 * sanitized HTML (still styled, still images, still links) or empty
 * string if the input was falsy.
 *
 * Idempotent: feeding the output back through is a no-op.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return "";
  let out = html;

  // 1. Drop dangerous tags AND their contents. Match `<tag ...>...</tag>`
  //    with non-greedy body. Repeat once after to catch nested cases
  //    where stripping an outer tag exposes another dangerous tag inside.
  for (const tag of DANGEROUS_TAGS) {
    const fullPair = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    out = out.replace(fullPair, "");
    // Self-closing or unpaired forms
    const selfClose = new RegExp(`<${tag}\\b[^>]*/?>`, "gi");
    out = out.replace(selfClose, "");
  }
  // Second pass — outer-strip may have revealed nested dangerous tags.
  for (const tag of DANGEROUS_TAGS) {
    const fullPair = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    out = out.replace(fullPair, "");
    const selfClose = new RegExp(`<${tag}\\b[^>]*/?>`, "gi");
    out = out.replace(selfClose, "");
  }

  // 2. Strip every on-* attribute (case-insensitive) inside any tag.
  //    Matches: onClick="..."  onclick='...'  onload=javascript:alert(1)
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");

  // 3. Neutralize dangerous URL protocols in href + src + xlink:href.
  out = out.replace(
    /\s(href|src|xlink:href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (_full, attr, _quotedWhole, dqVal, sqVal) => {
      const val = (dqVal ?? sqVal ?? "").trim();
      if (DANGEROUS_URL_PROTOCOLS.test(val)) {
        return ` ${attr}="#"`;
      }
      // Re-quote in double quotes for consistency
      return ` ${attr}="${val.replace(/"/g, "&quot;")}"`;
    }
  );

  // 4. Drop srcset so trackers can't ping via responsive-image vectors.
  out = out.replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi, "");

  // 5. Drop <a target=...> overrides without rel=noopener — replace
  //    blank-target attributes so the team isn't exposed to reverse-
  //    tabnabbing. We don't add rel attributes ourselves — the renderer
  //    can layer that on if it really wants HTML rendering.
  out = out.replace(/\starget\s*=\s*("_?blank"|'_?blank')/gi, "");

  return out;
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
