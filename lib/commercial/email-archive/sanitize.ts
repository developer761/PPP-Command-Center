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

/** Decode HTML entities + strip ALL whitespace/control chars within
 *  the scheme portion of a URL before testing against
 *  DANGEROUS_URL_PROTOCOLS. Closes the
 *  `href="java&#x09;script:alert(1)"` bypass — browsers normalize the
 *  entity-decoded value AND strip whitespace WITHIN the scheme token
 *  (not just leading) when parsing the link, so `java\tscript:` is
 *  treated as `javascript:`. A naive regex on the raw attribute
 *  would miss either of those steps. */
function normalizeUrlAttr(raw: string): string {
  const decoded = raw
    // Decode named entities + numeric refs that browsers honor in URL contexts.
    .replace(/&(?:amp|AMP);/g, "&")
    .replace(/&(?:colon|COLON);/g, ":")
    .replace(/&(?:Tab|tab|TAB|NewLine);/g, "\t")
    .replace(/&(?:nbsp|NBSP);/g, " ")
    .replace(/&#x([0-9a-fA-F]+);?/g, (_m, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/&#([0-9]+);?/g, (_m, dec) => {
      const n = parseInt(dec, 10);
      return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    // Strip leading whitespace + ASCII control chars that browsers
    // ignore when resolving the scheme.
    .replace(/^[\s\x00-\x1f]+/, "");
  // Strip ALL whitespace + control chars BEFORE the first `:` so
  // `java\tscript:` matches `javascript:`. Browsers do the same.
  const colonIdx = decoded.indexOf(":");
  if (colonIdx <= 0) return decoded.trim();
  const scheme = decoded.slice(0, colonIdx).replace(/[\s\x00-\x1f]+/g, "");
  const rest = decoded.slice(colonIdx);
  return (scheme + rest).trim();
}

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
  //    Entity-decode the value first so `java&#x09;script:` (with embedded
  //    tab) doesn't slip past the protocol regex — browsers decode entities
  //    AND normalize whitespace inside the scheme when resolving the link.
  //    Match the attribute anywhere it appears (with or without leading
  //    whitespace) — earlier regex required `\s` before the attr name,
  //    which silently missed `<a href=…>` where href is the first attr
  //    after the tag name (no whitespace before it). Audit fix
  //    2026-06-22: Vitest caught it. Use a word-boundary `\b` instead so
  //    we only match a real attribute, not a substring of another word.
  out = out.replace(
    /\b(href|src|xlink:href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (_full, attr, _quotedWhole, dqVal, sqVal) => {
      const raw = (dqVal ?? sqVal ?? "");
      const normalized = normalizeUrlAttr(raw);
      if (DANGEROUS_URL_PROTOCOLS.test(normalized)) {
        return `${attr}="#"`;
      }
      // Re-quote the ORIGINAL (un-decoded) value in double quotes so we
      // preserve display strings that intentionally contain entities.
      return `${attr}="${raw.replace(/"/g, "&quot;")}"`;
    }
  );

  // 4. Drop srcset so trackers can't ping via responsive-image vectors.
  out = out.replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi, "");

  // 5. Drop `style="…"` inline attributes — they're the carrier for
  //    expression(), -moz-binding, and `background:url(javascript:...)`
  //    style tricks that the protocol filter on href/src doesn't catch.
  //    Internal-team rendering doesn't need attacker-controlled CSS to
  //    look "good enough"; this is a clean security/UX trade.
  out = out.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, "");

  // 6. Drop <a target=...> overrides without rel=noopener — replace
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
