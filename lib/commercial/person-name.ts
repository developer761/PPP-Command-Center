/**
 * ONE way to turn a profile into the name a person reads.
 *
 * Karan, 2026-08-19, on an approval notification that read:
 *
 *   "stephanie@tomcopainting.com approved R1 · 08-18-2026 ABC Company …"
 *
 * Every actor-name path in the platform was `sf_user_name || email` — so any
 * teammate whose Salesforce name hasn't synced gets their full email address
 * dropped into the middle of an English sentence. It reads like a machine
 * wrote it, and on a phone the address alone eats the whole line.
 *
 * The local part of a work address is almost always the person: `stephanie`,
 * `brendan`, `karan.malhotra`. Using it is a guess, but it is a guess that is
 * right nearly every time and degrades gracefully when it isn't — "Ap" is
 * still better prose than "ap@tomcopainting.com".
 *
 * NOT used for anything that has to be an address — mailto:, the recipient of
 * an email, an audit record. Those keep the real string.
 */

/** Strip a trailing disambiguator: `jsmith2` → `jsmith`, `karan-01` → `karan`. */
function stripTrailingDigits(s: string): string {
  const out = s.replace(/[-_.]?\d+$/, "");
  return out || s;
}

function titleCasePart(part: string): string {
  if (!part) return part;
  // Leave an already-capitalised or all-caps token alone — "McCarthy" typed by
  // a human beats "Mccarthy" produced by us.
  if (/[A-Z]/.test(part)) return part;
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/** `stephanie@x.com` → `Stephanie`. `karan.malhotra@x.com` → `Karan Malhotra`. */
export function nameFromEmail(email: string | null | undefined): string | null {
  const raw = (email ?? "").trim();
  if (!raw) return null;
  const local = raw.split("@")[0] ?? "";
  if (!local) return null;
  const parts = stripTrailingDigits(local)
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map(titleCasePart);
  const out = parts.join(" ").trim();
  return out || null;
}

/**
 * The display name for a person, in this order: their real name, then a name
 * derived from their address, then the caller's fallback.
 */
export function personName(
  sfUserName: string | null | undefined,
  email: string | null | undefined,
  fallback = "A teammate"
): string {
  const sf = (sfUserName ?? "").trim();
  if (sf) return sf;
  return nameFromEmail(email) ?? fallback;
}
