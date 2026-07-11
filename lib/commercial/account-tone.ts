/**
 * Deterministic per-account color tone. Same account_id always maps
 * to the same hue platform-wide so users learn "Bob is coral, Tomco is
 * teal" over time.
 *
 * Extracted 2026-07-11 from app/commercial/opportunities/page.tsx so
 * every surface that displays an account (pipeline group cards,
 * invoice rows, activity feed, bell notifications, quick-sheet
 * header, notes, tasks, etc.) can render matching color + avatar
 * without redefining the palette or hash function.
 *
 * Algorithm:
 * - djb2 hash of the account_id (or "__no_account__" fallback)
 * - modulo 300 to leave a 60° gap for the blue/navy band (200-260°)
 *   which Karan banned platform-wide
 * - fixed saturation + lightness so every tone looks equally muted
 *   and readable regardless of hue
 * - returns CSSProperties objects for direct spread into inline
 *   style props (Tailwind can't emit arbitrary HSL at build time)
 */

type CSSProps = import("react").CSSProperties;

export type AccountTone = {
  /** Border color — apply as border-left-color for the 3-4px accent bar. */
  border: CSSProps;
  /** Tinted card/row background — very light wash. */
  headerBg: CSSProps;
  /** Circular initials avatar — background + text color together. */
  avatar: CSSProps;
  /** Account name text — bold enough to read on a tinted header. */
  nameText: CSSProps;
  /** Faint bg for inline chips ("2 open bids") that need the tone. */
  chipBg: CSSProps;
  /** Raw hue for consumers that want to compose their own HSL. */
  hue: number;
};

/**
 * Deterministic hash → hue, skipping the blue/navy band.
 */
export function accountColorTone(accountId: string | null | undefined): AccountTone {
  const key = accountId && accountId.trim() ? accountId : "__no_account__";
  // djb2 hash. Deterministic + well-distributed for short strings.
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  let hue = h % 300;
  // Skip blue band 200-260° by shifting into red/orange band instead.
  if (hue >= 200) hue = (hue + 60) % 360;
  return {
    border: { borderLeftColor: `hsl(${hue}, 62%, 55%)` },
    headerBg: { backgroundColor: `hsl(${hue}, 62%, 96%)` },
    avatar: {
      backgroundColor: `hsl(${hue}, 55%, 88%)`,
      color: `hsl(${hue}, 55%, 28%)`,
    },
    nameText: { color: `hsl(${hue}, 60%, 32%)` },
    chipBg: { backgroundColor: `hsl(${hue}, 62%, 93%)` },
    hue,
  };
}

/**
 * Extract initials for an avatar from a name string. Whitespace-only
 * and empty inputs return "?" so the avatar always has a glyph.
 *
 * Karan 2026-07-10 audit fix: trim FIRST, then split on whitespace,
 * then non-null-assert the first char (safe because filter(Boolean)
 * already dropped empty words), then double-fallback to "?" so an
 * emoji-only or punctuation-only name (e.g. "🏢") still lands on a
 * readable glyph.
 */
export function extractInitials(name: string | null | undefined): string {
  const trimmed = (name || "").trim() || "?";
  const initials =
    trimmed
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return initials;
}
