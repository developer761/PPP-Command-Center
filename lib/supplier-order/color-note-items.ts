import { parseColorNotes } from "@/lib/supplier-order/color-note-parse";
import { splitColorNoteOffer } from "@/lib/supplier-order/color-note-split";

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
/** All four are recognized from one shared list — this file used to know only
 *  about the finish one, so the estimator was offered "Walls" and a rejected
 *  paint line as things to buy. */

/**
 * The flat shape: one string per orderable color.
 *
 * Superseded by parseColorNotes (lib/supplier-order/color-note-parse.ts), which
 * reads the same notes as a document — rooms, qualifiers and remarks kept apart
 * — and is what the order page renders. This DELEGATES rather than parsing
 * again, so there is exactly one parser: a second copy is how the two would
 * drift and how the bugs Katie found on 2026-10-01 would come back in one of
 * them.
 */
export function colorNoteLines(raw: string | null | undefined): string[] {
  return parseColorNotes(raw).offers.map((o) => o.line);
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
 * One color-note offer, as the order line it becomes.
 *
 * Kate 2026-10-06 — see color-note-split.ts. `label` is now the COLOR alone so
 * the vendor email reads like every other line; the room and surface move to
 * `scope`, and the sheen the note already named prefills `finish` instead of
 * being retyped.
 */
export type OfferIdentity = {
  /** The color alone — what goes on the order and to the vendor. */
  label: string;
  finish: string | null;
  /** "Ceiling — All rooms". Screen only. */
  scope: string | null;
  /**
   * The old flattened form, kept ONLY so an item added before today is still
   * recognized as on-order. Without it, reopening a draft would offer every
   * previously-added color again and the estimator would buy it twice.
   */
  legacyLabel: string;
};

export function offerIdentity(
  offer: { line: string; room?: string | null },
  fallbackRoom?: string | null
): OfferIdentity {
  const room = offer.room ?? fallbackRoom ?? null;
  const split = splitColorNoteOffer(offer.line, room);
  return {
    label: split.color,
    finish: split.finish,
    scope: split.scope,
    legacyLabel: customItemLabel(room, offer.line),
  };
}

/**
 * Is this offer already on the order?
 *
 * Matched on color AND scope, not on color alone: "Door: Super White" written
 * identically into the Kitchen, Hall and Bedroom line items is three separate
 * things to buy, and collapsing them to one is the bug customItemLabel was
 * written to fix — splitting the room back out of the label would have
 * reintroduced it.
 *
 * Still answers true for an item saved in the old flattened form, so a draft
 * from before today does not re-offer everything it already holds.
 */
export function isOfferOnOrder(
  items: ReadonlyArray<{ label: string; scope?: string | null }>,
  id: OfferIdentity
): boolean {
  const color = itemKey(id.label);
  if (!color) return false;
  const scope = itemKey(id.scope ?? "");
  const legacy = itemKey(id.legacyLabel);
  return items.some((it) => {
    if (itemKey(it.label) === legacy) return true; // added before 2026-10-06
    return itemKey(it.label) === color && itemKey(it.scope ?? "") === scope;
  });
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
  // Not every Area__c is a room. WO 00316248's says "See Notes", and the
  // prefix went onto a custom item as "See Notes · Siding: HC-6 …" — which
  // reads to a vendor as an instruction, on a line they are supposed to price.
  // A placeholder identifies nothing, so it disambiguates nothing.
  if (isPlaceholderRoom(r)) return l;
  return `${r} · ${l}`;
}

/** Labels that are not a room: our own fallbacks, and the notes-pointer reps
 *  type into Area__c when the colors live somewhere else. */
export function isPlaceholderRoom(room: string): boolean {
  const r = room.trim().toLowerCase();
  if (!r) return true;
  if (["untitled area", "unnamed area", "unnamed room", "area", "room", "n/a", "tbd"].includes(r)) return true;
  return /\bsee\s*(the\s*)?notes?\b/.test(r);
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
 *  siding paint is a gallon, and rounding down is the silent under-order.
 *  Capped at 99, the same ceiling the persistence boundary applies — without
 *  it a typed 999 stayed 999 until the page was reloaded, and the draft in
 *  between is what the vendor is sent. */
export function orderableQty(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.min(99, Math.ceil(n)));
}
