/**
 * What the customer actually chose, flattened into the lines a receipt prints.
 *
 * Kate, 2026-10-01: "An automatic email to customer upon form submission as a
 * 'receipt' of customer's selections + include a button to the form to allow
 * them to make edits when needed. Rationale: Provides a 'receipt' and a chance
 * to correct errors, preventing disputes."
 *
 * The dispute is the point, so this errs toward showing MORE than the form did:
 * a surface the customer deliberately skipped prints as "Not painting" rather
 * than being dropped. A receipt that silently omits a room cannot settle an
 * argument about whether that room was ever included — which is the exact
 * argument it exists to prevent.
 *
 * Pure and free of the email, Salesforce and the database so the suite can test
 * it (vitest here is node-env — no DOM, no network). The rendering lives in
 * lib/email/resend.ts; what to say lives here.
 */

export type ReceiptSurface = {
  surface: string;
  colorName: string | null;
  colorCode: string | null;
  finish: string | null;
  skipped: boolean;
};

export type ReceiptRoom = {
  room: string;
  surfaces: ReceiptSurface[];
  notes: string | null;
};

/** One line item as the submit route has already sanitized it. */
export type ReceiptInputLine = {
  id?: string | null;
  surfaces?: unknown;
  notes?: string | null;
};

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Build the receipt.
 *
 * `roomLabelById` comes from the FRESH work order rather than the posted body:
 * the customer's browser never sends a room name, and the one the form showed
 * is the one they will be looking for in this email.
 */
export function buildReceiptRooms(input: {
  lineItems: ReadonlyArray<ReceiptInputLine>;
  roomLabelById: ReadonlyMap<string, string>;
}): ReceiptRoom[] {
  const rooms: ReceiptRoom[] = [];
  for (const li of input.lineItems) {
    const id = typeof li.id === "string" ? li.id : "";
    const surfacesRaw = Array.isArray(li.surfaces) ? li.surfaces : [];
    const surfaces: ReceiptSurface[] = [];
    for (const raw of surfacesRaw) {
      const s = (raw ?? {}) as Record<string, unknown>;
      const surface = str(s.surface);
      if (!surface) continue;
      const skipped = s.skipped === true;
      const colorName = str(s.colorName);
      // A surface with neither a color nor a skip is one the customer simply
      // never got to. It is still printed — "no color chosen yet" is the line
      // most likely to make somebody open the form again before we order, and
      // hiding it is how a half-finished job looks finished.
      surfaces.push({
        surface,
        colorName: skipped ? null : colorName,
        colorCode: skipped ? null : str(s.colorCode),
        finish: skipped ? null : str(s.finish),
        skipped,
      });
    }
    if (surfaces.length === 0 && !str(li.notes)) continue;
    rooms.push({
      room: input.roomLabelById.get(id) ?? "Unnamed area",
      surfaces,
      notes: str(li.notes),
    });
  }
  return rooms;
}

/** How a single surface reads on the receipt. One function so the HTML and the
 *  plain-text body can never word the same choice differently. */
export function receiptSurfaceText(s: ReceiptSurface): string {
  if (s.skipped) return "Not painting this surface";
  if (!s.colorName) return "No color chosen yet";
  const code = s.colorCode && !s.colorName.includes(s.colorCode) ? ` (${s.colorCode})` : "";
  // The finish is deliberately spelled out as missing. From 2026-10-01 the form
  // no longer fills one in (Alex), so "—" next to a color is a real, common
  // state, and the customer is the only person who can resolve it.
  const finish = s.finish ? ` · ${s.finish}` : " · finish not chosen";
  return `${s.colorName}${code}${finish}`;
}

/** True when there is nothing worth emailing a receipt about. */
export function receiptIsEmpty(rooms: ReadonlyArray<ReceiptRoom>, globalNotes: string | null): boolean {
  if (str(globalNotes)) return false;
  return !rooms.some((r) => r.notes || r.surfaces.some((s) => s.skipped || s.colorName));
}
