/**
 * Color-swatch resolver for the customer form.
 *
 * PPP's PaintColor.HexValue__c is null on a large share of records — when
 * we render the form, those colors get a gray placeholder swatch that
 * confuses customers ("did I pick gray?"). This helper provides a best-
 * effort visual approximation so the swatch at least HINTS at the family.
 *
 * Priority chain:
 *   1. Real hex from SF (when present + valid) — definitive
 *   2. Name keyword match — "white", "blue", "green", "taupe", etc. in
 *      the color name map to approximate hex values
 *   3. Null — caller falls back to the code badge / placeholder
 *
 * The keyword map is intentionally conservative. "Stardust" and creative
 * names that don't contain a color word return null (don't guess); but
 * "Stardust White", "Ocean Blue", "Forest Green" all resolve.
 *
 * Pure function — safe to use client-side. Lowercased name is computed
 * once per call.
 */

/** Map of color keywords → representative hex value. Ordered by specificity
 *  so we check 2-word combos before single-word ones (e.g., "off white" before
 *  "white"). Ranged to common paint terms PPP customers actually see. */
const COLOR_KEYWORDS: Array<{ pattern: RegExp; hex: string }> = [
  // Whites + off-whites (very common)
  { pattern: /\boff[\s-]?white\b/i, hex: "#f5efe6" },
  { pattern: /\bsnow\b/i,           hex: "#fafafa" },
  { pattern: /\bivory\b/i,          hex: "#f3eee0" },
  { pattern: /\bcream\b/i,          hex: "#f0e6cf" },
  { pattern: /\bivor\b/i,           hex: "#f3eee0" },
  // Grays (the popular ones)
  { pattern: /\bcharcoal\b/i,       hex: "#3b3b3a" },
  { pattern: /\bslate\b/i,          hex: "#5a6770" },
  { pattern: /\bgreig?e\b/i,        hex: "#a89e8e" },
  // Tans + beiges
  { pattern: /\btaupe\b/i,          hex: "#8a7967" },
  { pattern: /\bbeige\b/i,          hex: "#d6c7ab" },
  { pattern: /\btan\b/i,            hex: "#c8a982" },
  { pattern: /\bsand\b/i,           hex: "#c2a777" },
  { pattern: /\bkhaki\b/i,          hex: "#a89968" },
  // Browns
  { pattern: /\bchocolate\b/i,      hex: "#4a2c1d" },
  { pattern: /\bcoffee\b/i,         hex: "#5a3a23" },
  { pattern: /\bcaramel\b/i,        hex: "#a07550" },
  { pattern: /\bmocha\b/i,          hex: "#7a5446" },
  // Blues
  { pattern: /\bnavy\b/i,           hex: "#1f3047" },
  { pattern: /\bcobalt\b/i,         hex: "#1f4e91" },
  { pattern: /\bturquoise\b/i,      hex: "#2cb1b3" },
  { pattern: /\bteal\b/i,           hex: "#2c7a7b" },
  { pattern: /\bsky\b/i,            hex: "#9cc1d8" },
  // Greens
  { pattern: /\bforest\b/i,         hex: "#2f5b3a" },
  { pattern: /\bsage\b/i,           hex: "#a4ad9d" },
  { pattern: /\bmint\b/i,           hex: "#c2e4cf" },
  { pattern: /\bolive\b/i,          hex: "#6a6b3a" },
  // Reds + warm tones
  { pattern: /\bcrimson\b/i,        hex: "#8e1f25" },
  { pattern: /\bbrick\b/i,          hex: "#8a3a32" },
  { pattern: /\brust\b/i,           hex: "#a44e2a" },
  { pattern: /\bsalmon\b/i,         hex: "#f0a994" },
  { pattern: /\bcoral\b/i,          hex: "#e88370" },
  // Yellows + golds
  { pattern: /\bmustard\b/i,        hex: "#c69228" },
  { pattern: /\bgold\b/i,           hex: "#b8893a" },
  { pattern: /\bbutter\b/i,         hex: "#f1d589" },
  { pattern: /\blemon\b/i,          hex: "#f4dd6a" },
  // Purples / pinks
  { pattern: /\blilac\b/i,          hex: "#bda3cd" },
  { pattern: /\blavender\b/i,       hex: "#b8a5d4" },
  { pattern: /\bplum\b/i,           hex: "#603b5a" },
  { pattern: /\brose\b/i,           hex: "#d28a8a" },
  // Generic single-word fallbacks — checked AFTER specific combos above
  { pattern: /\bwhite\b/i,          hex: "#f5f1eb" },
  { pattern: /\bblack\b/i,          hex: "#1c1c1c" },
  { pattern: /\bgray\b/i,           hex: "#a0a0a0" },
  { pattern: /\bgrey\b/i,           hex: "#a0a0a0" },
  { pattern: /\bred\b/i,            hex: "#b03a3a" },
  { pattern: /\bblue\b/i,           hex: "#5a7fa8" },
  { pattern: /\bgreen\b/i,          hex: "#638a5a" },
  { pattern: /\byellow\b/i,         hex: "#e5c668" },
  { pattern: /\borange\b/i,         hex: "#d4843a" },
  { pattern: /\bpurple\b/i,         hex: "#856097" },
  { pattern: /\bpink\b/i,           hex: "#dca5b0" },
  { pattern: /\bbrown\b/i,          hex: "#7a5a3a" },
  { pattern: /\bsilver\b/i,         hex: "#bcbcbc" },
];

const HEX_OK = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Returns a usable hex value for the swatch. Priority:
 *   - actualHex if present + valid
 *   - keyword-matched approximate hex from the name
 *   - null → caller renders placeholder
 *
 * The `isApproximate` flag tells the UI whether to show a "(approximate)"
 * hint so customers know the swatch isn't pixel-exact.
 */
export function resolveSwatchHex(
  actualHex: string | null | undefined,
  name: string | null | undefined,
  code: string | null | undefined
): { hex: string; isApproximate: boolean } | null {
  if (actualHex && HEX_OK.test(actualHex)) {
    return { hex: actualHex, isApproximate: false };
  }
  const haystack = `${name ?? ""} ${code ?? ""}`;
  for (const { pattern, hex } of COLOR_KEYWORDS) {
    if (pattern.test(haystack)) {
      return { hex, isApproximate: true };
    }
  }
  return null;
}
