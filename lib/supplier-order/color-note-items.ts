import { extractCustomerFreeText, extractMachineColorLines } from "@/lib/customer-form/notes";

/**
 * Color Notes → custom color items, one line at a time.
 *
 * Color notes never reach the vendor email (R4.14, re-confirmed by Kate
 * 2026-09-15). Anything in them that needs buying has to become a custom color
 * item. On a job like WO 00316248 — the rep put every exterior color only in
 * Color Notes — that meant retyping three colors the estimator could already
 * see on the screen, and an order that went out without them if they didn't.
 *
 * So each line of a Salesforce line item's Color Notes is offered as a
 * candidate the estimator can send to the custom-item form. The estimator
 * still chooses (a note can be "please be careful with the shrubs") and still
 * sets the quantity: a default of 1 gal on a whole house's siding would be a
 * silent under-order.
 */

/** One offerable line per color written in ColorNotes__c, machine lines first. */
export function colorNoteLines(raw: string | null | undefined): string[] {
  const machine = extractMachineColorLines(raw);
  const human = extractCustomerFreeText(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // Reps bullet their lists; the bullet is not part of the color.
    .map((l) => l.replace(/^\s*(?:[-–—•*]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    // A bare heading ("Exterior:") or a separator carries no color to order.
    .filter((l) => !/^[^:\n]{1,60}:$/.test(l) && !/^[-–—_=\s]+$/.test(l));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of [...machine, ...human]) {
    const k = itemKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/** Case- and whitespace-insensitive, so an edited-then-added line still matches. */
export function itemKey(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when a custom color item with this text is already on the order. */
export function isOnOrder(items: ReadonlyArray<{ label: string }>, line: string): boolean {
  const k = itemKey(line);
  return items.some((it) => itemKey(it.label) === k);
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
