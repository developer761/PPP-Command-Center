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

/** Looks like a deliverable address. Same shape every admin send route uses. */
/** Exported so a caller supplying its own recipient validates it the same
 *  way receiptRecipient does — two different notions of "a valid address"
 *  is how one path sends and the other silently refuses. */
export const EMAIL_RE = /^[a-z0-9._+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

/**
 * Who the receipt is actually addressed to.
 *
 * This exists because of one specific trap. `customer_form_tokens.customer_email`
 * is the customer on a normal token — but on a kind="internal" row it holds the
 * PPP STAFF MEMBER who opened the entry screen, and `customer_name` holds a
 * label like "[Internal Entry] katie@precisionpaintingplus.net". Reading the
 * obvious column therefore emails an AM a receipt that opens "Hi Katie" and
 * lists somebody else's bathroom.
 *
 * So an internal entry takes its recipient from the WORK ORDER (resolved by the
 * same schema-driven discovery the "Send Color Form" modal uses), and returns
 * null rather than falling back to the token when the work order has no email —
 * a missing address is a thing to tell the AM about, never a reason to send it
 * to the nearest address we happen to have.
 */
export function receiptRecipient(input: {
  tokenKind: string | null | undefined;
  tokenEmail: string | null | undefined;
  tokenCustomerName: string | null | undefined;
  /** Resolved from the WorkOrder — only consulted for internal entry. */
  workOrderEmail?: string | null;
  workOrderCustomerName?: string | null;
}): { email: string | null; name: string | null } {
  const isInternal = input.tokenKind === "internal";
  const raw = (isInternal ? input.workOrderEmail : input.tokenEmail) ?? "";
  const email = EMAIL_RE.test(raw.trim()) ? raw.trim() : null;

  const rawName = (isInternal ? input.workOrderCustomerName ?? input.tokenCustomerName : input.tokenCustomerName) ?? null;
  // Never greet a customer with the staff label these rows carry.
  const name = rawName && !/^\s*\[internal entry\]/i.test(rawName) ? rawName : null;

  return { email, name };
}

/**
 * The COLOR cell of the receipt table, without the finish.
 *
 * Split out from receiptSurfaceText (which still writes the one-line plain-text
 * version) because the HTML receipt reads as a table: color and finish belong
 * in their own columns, and the "·" that joined them made every row look like a
 * sentence instead of a line item. Karan, 2026-10-01: "it looks like a lot and
 * not like a receipt".
 */
export function receiptColorText(s: ReceiptSurface): string {
  if (s.skipped) return "Not painting this surface";
  if (!s.colorName) return "No color chosen yet";
  return s.colorName;
}

/** The color CODE, when it adds something the name doesn't already say. */
export function receiptColorCode(s: ReceiptSurface): string | null {
  if (s.skipped || !s.colorName || !s.colorCode) return null;
  return s.colorName.includes(s.colorCode) ? null : s.colorCode;
}

/** The FINISH cell. Empty string when the row has nothing to say about one. */
export function receiptFinishText(s: ReceiptSurface): string {
  if (s.skipped || !s.colorName) return "";
  return s.finish || "Not chosen";
}
