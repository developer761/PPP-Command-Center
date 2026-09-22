/**
 * Which fields on a job can be edited in place, and how.
 *
 * Salesforce puts a pencil beside every field on the Details tab; you click it,
 * type, and save without leaving the record. Ours does the same for the fields
 * people actually touch — the rest keep the full edit page, because building
 * twenty-five one-field forms to avoid one page navigation is a bad trade.
 *
 * **This list is a security boundary, not a convenience.** The inline writer
 * takes a field NAME from the request, so without an allowlist it would happily
 * write `status`, `decided_at` or `accepted_contract_cents` — columns with
 * their own writers, their own audit trail and, in two cases, money attached.
 * Anything not named here cannot be written by that path at all.
 *
 * Deliberately absent, and why:
 *   status / sub_status  — `changeOpportunityStatus` is the one writer; it
 *                          logs, cascades to proposals, stamps decided_at and
 *                          creates the project. A bare column write skips all
 *                          of it.
 *   decided_at           — derived from the status change that set it.
 *   accepted_contract_cents — WAS absent on exactly that reasoning ("set at
 *                          award, never by hand"). Stephanie, 2026-09-22:
 *                          "I need to be able to change original contract
 *                          amounts on jobs to correct this." The migration put
 *                          Salesforce's WITH-change-order figure into the
 *                          contract BASE on 18 jobs, and there was nowhere in
 *                          the product to correct it. A number that can be
 *                          wrong and cannot be fixed is worse than one that
 *                          can be edited, so it is editable now — typed in
 *                          DOLLARS, stored in cents, and audit-logged like
 *                          every other field write.
 *   project_number       — already printed on documents in the field.
 */

export type InlineFieldType = "text" | "textarea" | "date" | "number" | "money";

export type InlineField = {
  name: string;
  label: string;
  type: InlineFieldType;
  /** Shown under the input while editing. */
  hint?: string;
  /** Cap on stored length — a paste of a whole email into "Title" is a real
   *  thing people do. */
  maxLength?: number;
};

export const INLINE_FIELDS: InlineField[] = [
  { name: "title", label: "Title", type: "text", maxLength: 200 },
  /**
   * THE SIGNED CONTRACT, before change orders.
   *
   * Change orders are added on top of this by every consumer
   * (`contractCents = base + netApprovedCOs`), so this must be the ORIGINAL
   * amount — entering the with-change-orders total here is precisely the
   * double-count Stephanie reported.
   */
  { name: "accepted_contract_cents", label: "Original contract", type: "money",
    hint: "The signed contract BEFORE change orders — approved COs are added to this automatically." },
  { name: "client_name", label: "Client name", type: "text", maxLength: 160,
    hint: "The end client, when it differs from the GC." },
  { name: "description", label: "Description", type: "textarea", maxLength: 4000 },
  // probability_pct is deliberately absent — removed from every form
  // 2026-08-12 (Brendan: "I don't use this"). Leaving it inline-editable would
  // have quietly reintroduced the field the forms just dropped.
  { name: "rfp_received_at", label: "RFP received", type: "date" },
  { name: "proposal_due_at", label: "Proposal due", type: "date" },
  // AUDIT 2026-08-13 (Karan: "I click Fix and nothing happens"). The
  // "No follow-up scheduled" warning offered a Fix that pointed at the Overview
  // tab — where there was no way to set one. The only control that wrote
  // `follow_up_at` lived inside the status-change form, so the only way to
  // book a chase was to move the deal's stage, which is not what the warning
  // was asking for. Editable in place now, so Fix can open this row directly.
  { name: "follow_up_at", label: "Follow-up", type: "date",
    hint: "When to chase the GC. The Follow-up warning links straight here." },
  /**
   * WHEN WE THINK THE WORK HAPPENS — editable from the RFP stage on.
   *
   * Karan 2026-09-17: "RFP when we think when this project is gonna happen."
   *
   * This REVERSES a call Brendan made on 2026-08-12 ("too early to determine at
   * the opportunity level"), so it is worth saying why rather than quietly
   * flipping it. Two things changed:
   *
   *   · The columns are already there and already FULL — the Salesforce import
   *     put a start on 74 of 132 deals and an end on 67, and the job page has
   *     been displaying them read-only ever since. The date was being shown and
   *     could not be corrected, which is the worst of both.
   *   · The projected calendar Karan asked for is a projection of WHEN. Without
   *     an expected date on a deal that has not been won yet, there is nothing
   *     to project — a job only gets real dates once it is scheduled, by which
   *     point it is not a projection.
   *
   * Brendan's point still stands about certainty, so the label and hint say
   * plainly that it is a guess. It is not the scheduled date: that lives on the
   * work order and Field Ops, and nothing here writes to those.
   */
  { name: "proposed_start_at", label: "Expected start", type: "date",
    hint: "Your best guess at when work begins — not the scheduled date, which comes from the work order." },
  { name: "proposed_end_at", label: "Expected finish", type: "date",
    hint: "Roughly how long it runs. Used for forecasting crew load, not for scheduling." },
  { name: "property_street", label: "Street", type: "text", maxLength: 200 },
  { name: "property_city", label: "City", type: "text", maxLength: 120 },
  { name: "property_state", label: "State", type: "text", maxLength: 2 },
  { name: "property_zip", label: "ZIP", type: "text", maxLength: 10 },
];

export function inlineField(name: string): InlineField | undefined {
  return INLINE_FIELDS.find((f) => f.name === name);
}

/**
 * Coerce a submitted value to what the column expects, or explain why not.
 *
 * Returns `{ value }` on success — `null` meaning "clear it", which is a
 * legitimate edit and must not be confused with a validation failure.
 */
export function parseInlineValue(
  field: InlineField,
  raw: string
): { value: string | number | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };

  if (field.maxLength && trimmed.length > field.maxLength) {
    return { error: `${field.label} is limited to ${field.maxLength} characters.` };
  }

  if (field.type === "number") {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { error: `${field.label} must be a number.` };
    return { value: Math.round(n) };
  }

  if (field.type === "money") {
    /**
     * DOLLARS IN, CENTS OUT.
     *
     * The column is cents and the human types dollars. Reading "165000" as
     * 165,000 cents would silently record a $165,000 contract as $1,650 — a
     * money field that is wrong by 100x and looks plausible is worse than one
     * that refuses. So the parse is explicit, and strips the punctuation
     * people actually type ("$165,000.00").
     */
    const cleaned = trimmed.replace(/[$,\s]/g, "");
    if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
      return { error: `${field.label} must be an amount, like 165000 or 165,000.00.` };
    }
    const dollars = Number(cleaned);
    if (!Number.isFinite(dollars)) return { error: `${field.label} must be an amount.` };
    // Guard the fat finger. Nothing Tomco bills is anywhere near this, and a
    // stray keystroke on a contract feeds margin, AR and the GC's invoice.
    if (Math.abs(dollars) > 100_000_000) {
      return { error: `${field.label} looks too large — check the amount.` };
    }
    return { value: Math.round(dollars * 100) };
  }

  if (field.type === "date") {
    // The date input gives YYYY-MM-DD. Anything else is a hand-typed value or
    // a stale browser, and writing it would land an unparseable string in a
    // column every elapsed-time figure on the platform reads.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return { error: `${field.label} must be a date.` };
    }
    return { value: trimmed };
  }

  if (field.name === "property_state") {
    if (!/^[A-Za-z]{2}$/.test(trimmed)) return { error: "State must be two letters." };
    return { value: trimmed.toUpperCase() };
  }

  return { value: trimmed };
}
