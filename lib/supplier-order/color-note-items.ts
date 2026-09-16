import { extractCustomerFreeText, extractMachineColorLines } from "@/lib/customer-form/notes";

/**
 * Color Notes → custom color items, one color at a time.
 *
 * Color notes never reach the vendor email (R4.14, re-confirmed by Kate
 * 2026-09-15). Anything in them that needs buying has to become a custom color
 * item. On a job like WO 00316248 — the rep put every exterior color only in
 * Color Notes — that meant retyping colors the estimator could already see, and
 * an order that went out without them if they didn't.
 *
 * So each color in a line's Color Notes is offered as a candidate. The
 * estimator still chooses (a note can be "please be careful with the shrubs")
 * and still types the quantity: a default of 1 gal on a whole house's siding
 * would be a silent under-order.
 */

/** Longest label `build-state` will persist. Matching has to fold the same way
 *  or a long line reads "on order" until the page reloads and then doesn't. */
const LABEL_MAX = 300;

/** "Siding:", "Shutters, Doors and Iron Railings:" — a surface the note names. */
const SURFACE_LEAD = /^[A-Za-z][A-Za-z0-9 ,'&/()+-]{0,60}:\s*\S/;

/**
 * The machine trailer the submit route writes when Salesforce cannot store a
 * finish:
 *
 *     Finish not available in the Salesforce list — recorded here:
 *       High-Gloss
 *
 * Its values are indented, and "High-Gloss" on its own is a finish, not
 * something a vendor can sell. Both the header and everything indented under
 * it are bookkeeping.
 */
const UNSTORABLE_FINISH_HEADER = /finish(es)? not available in the salesforce list/i;
/** The submit route's own cap marker. Never a color. */
const TRUNCATION_MARKER = /^\[…?\s*truncated/i;

/** Split "Siding: HC-6. Trim: OC-95." into one entry per named surface. */
function splitRun(line: string): string[] {
  const parts: string[] = [];
  let rest = line;
  // Only split where the text AFTER the break starts a new "Surface: color".
  // Anything else — a sentence, a decimal, "approx. 2 gal" — stays whole.
  const BREAK = /\.\s+(?=[A-Za-z][A-Za-z0-9 ,'&/()+-]{0,60}:\s*\S)/;
  for (;;) {
    const m = BREAK.exec(rest);
    if (!m) break;
    parts.push(rest.slice(0, m.index).trim());
    rest = rest.slice(m.index + m[0].length);
  }
  parts.push(rest.trim());
  return parts.filter(Boolean).map((p) => p.replace(/\.$/, "").trim());
}

/** One offerable entry per color written in ColorNotes__c, machine lines first. */
export function colorNoteLines(raw: string | null | undefined): string[] {
  const machine = extractMachineColorLines(raw);
  const rawHuman = extractCustomerFreeText(raw).replace(/\r\n?/g, "\n").split("\n");

  const human: string[] = [];
  let inFinishTrailer = false;
  for (const original of rawHuman) {
    const indented = /^\s{2,}\S/.test(original);
    const line = original
      // Reps bullet their lists; the bullet is not part of the color.
      .replace(/^\s*(?:[-–—•*]|\d+[.)])\s+/, "")
      .trim();
    if (!line) { inFinishTrailer = false; continue; }
    if (UNSTORABLE_FINISH_HEADER.test(line)) { inFinishTrailer = true; continue; }
    // The trailer's values are indented under its header. An unindented line
    // ends it — a customer's own words are not part of our bookkeeping.
    if (inFinishTrailer && indented) continue;
    inFinishTrailer = false;
    if (TRUNCATION_MARKER.test(line)) continue;
    // A bare heading ("Exterior:", "Exterior (2nd floor: rear):") names where
    // the colors go; the colors are on the lines under it.
    if (/:\s*$/.test(line)) continue;
    // Nothing to order in punctuation or a separator rule.
    if (!/[A-Za-z0-9]/.test(line)) continue;
    human.push(...(SURFACE_LEAD.test(line) ? splitRun(line) : [line]));
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of [...machine, ...human]) {
    const k = itemKey(l);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/** Case-, space- and length-insensitive, matching what actually gets stored. */
export function itemKey(label: string): string {
  return label.trim().slice(0, LABEL_MAX).replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when a custom color item with this text is already on the order. */
export function isOnOrder(items: ReadonlyArray<{ label: string }>, line: string): boolean {
  const k = itemKey(line);
  return k.length > 0 && items.some((it) => itemKey(it.label) === k);
}

/**
 * The room this color belongs to, carried into the item's text.
 *
 * Without it, the color form's own output — "Door: Super White (OC-152)",
 * written identically into the Kitchen, Hall and Bedroom line items — matched
 * as one item, so adding the Kitchen's door paint marked the other two rooms
 * "on order" and one door's worth of paint covered three.
 */
export function customItemLabel(room: string | null | undefined, line: string): string {
  const r = (room ?? "").trim();
  const l = line.trim();
  if (!r || l.toLowerCase().startsWith(r.toLowerCase())) return l;
  return `${r} · ${l}`;
}

/**
 * Already covered by the buy-list above — the rep wrote a color into the notes
 * AND set it on the Salesforce color field, so it is already being ordered
 * with a computed gallon count. Adding it again double-orders.
 */
export function inBuyList(
  line: string,
  estimates: ReadonlyArray<{ colorName: string; colorCode: string | null }>
): boolean {
  const hay = ` ${line.toLowerCase().replace(/\s+/g, " ")} `;
  return estimates.some((e) => {
    const code = (e.colorCode ?? "").trim().toLowerCase();
    // Codes are distinctive ("hc-6", "sw6462"); bound them so "hc-6" doesn't
    // match inside "hc-62".
    if (code.length >= 2 && new RegExp(`(^|[^a-z0-9-])${escapeRe(code)}([^a-z0-9-]|$)`).test(hay)) return true;
    const name = e.colorName.trim().toLowerCase();
    return name.length >= 4 && hay.includes(name);
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * An id no current item holds. The form derived ids from the list LENGTH, so
 * removing the first of two items and adding one with a similar label reused
 * the survivor's id — and React then treats two rows as one.
 */
export function nextCustomColorId(items: ReadonlyArray<{ id: string }>, label: string): string {
  const slug = label.trim().slice(0, 16).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
  const taken = new Set(items.map((i) => i.id));
  for (let n = items.length; ; n++) {
    const id = `cc-${n}-${slug}`;
    if (!taken.has(id)) return id;
  }
}

/** Quantities are whole units a vendor can sell. Round UP: half a gallon of
 *  siding paint is a gallon, and rounding down is the silent under-order. */
export function orderableQty(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.ceil(n));
}
