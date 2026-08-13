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
 *   accepted_contract_*  — the signed contract. Set at award, never by hand
 *                          from a text box.
 *   project_number       — already printed on documents in the field.
 */

export type InlineFieldType = "text" | "textarea" | "date" | "number";

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
  // proposed_start_at / proposed_end_at are absent too — Brendan 2026-08-12:
  // "too early to determine at the opportunity level". Dates for the WORK live
  // on the project once there is one.
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
