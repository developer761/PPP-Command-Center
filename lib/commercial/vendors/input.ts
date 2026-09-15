/**
 * Vendor form input → a row patch. Pure, so the settings page's create and edit
 * paths go through ONE function and cannot drift (the create/edit drift has
 * shipped three times on this platform — see create-and-edit-stay-in-step).
 *
 * Status is deliberately NOT a form field: deactivate and reactivate are their
 * own actions, so saving a stale edit form can never flip a vendor back on.
 */

import { isVendorKind, normalizeVendorName, formatVendorPhone, type VendorKind } from "./constants";

export type VendorFields = {
  name: string;
  kind: VendorKind;
  specialty: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payment_terms: string | null;
  preferred_payment: string | null;
  w9_on_file: boolean;
  compliance_status: string | null;
  notes: string | null;
};

/** Every field the vendor form posts. The settings page renders from this list
 *  and the parser reads from it, so a field can't be shown and never saved. */
export const VENDOR_TEXT_FIELDS = [
  "specialty",
  "contact_name",
  "phone",
  "email",
  "website",
  "address_line1",
  "city",
  "state",
  "zip",
  "payment_terms",
  "preferred_payment",
  "compliance_status",
  "notes",
] as const;

const MAX: Record<(typeof VENDOR_TEXT_FIELDS)[number], number> = {
  specialty: 120,
  contact_name: 120,
  phone: 40,
  email: 200,
  website: 200,
  address_line1: 200,
  city: 80,
  state: 40,
  zip: 20,
  payment_terms: 80,
  preferred_payment: 80,
  compliance_status: 80,
  notes: 2000,
};

type Getter = { get(name: string): FormDataEntryValue | null };

const text = (v: FormDataEntryValue | null, max: number): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};

export function parseVendorForm(
  form: Getter
): { ok: true; value: VendorFields } | { ok: false; error: string } {
  const name = normalizeVendorName(typeof form.get("name") === "string" ? (form.get("name") as string) : "");
  if (!name) return { ok: false, error: "Give the vendor a name." };
  const kindRaw = form.get("kind");
  const out: VendorFields = {
    name,
    // An unknown kind is a forged post, not a choice — default rather than fail
    // the whole save (the picker only ever offers the two).
    kind: isVendorKind(kindRaw) ? kindRaw : "retail",
    specialty: null,
    contact_name: null,
    phone: null,
    email: null,
    website: null,
    address_line1: null,
    city: null,
    state: null,
    zip: null,
    payment_terms: null,
    preferred_payment: null,
    w9_on_file: form.get("w9_on_file") === "on" || form.get("w9_on_file") === "1",
    compliance_status: null,
    notes: null,
  };
  for (const f of VENDOR_TEXT_FIELDS) out[f] = text(form.get(f), MAX[f]);
  out.phone = formatVendorPhone(out.phone);
  if (out.email) out.email = out.email.toLowerCase();
  if (out.state) out.state = out.state.toUpperCase();
  return { ok: true, value: out };
}
