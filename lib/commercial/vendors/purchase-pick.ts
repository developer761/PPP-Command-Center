/**
 * The seam between the purchase form's vendor picker and the costs actions.
 *
 * FormData is stringly-typed on both sides, and "a form posting a field its
 * action never read" has already shipped on this platform. So the hidden-field
 * names live HERE, once: the form renders `VENDOR_PICK_FIELDS`, the actions
 * read through `readVendorPick`, and a rename on one side is a rename on both.
 */

export const VENDOR_PICK_FIELDS = {
  /** The directory vendor the typed name resolved to, or "". */
  id: "vendor_id",
  /** "1" when the crew member tapped "Add … as a new vendor". */
  createNew: "vendor_new",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Getter = { get(name: string): FormDataEntryValue | null };

export type VendorPick = {
  id: string | null;
  createNew: boolean;
  /** Round-trip params for a rejected save (costs-tool's pu_* convention). */
  preserve: { pu_vid?: string; pu_vnew?: string };
};

export function readVendorPick(form: Getter): VendorPick {
  const rawId = form.get(VENDOR_PICK_FIELDS.id);
  const id = typeof rawId === "string" && UUID_RE.test(rawId) ? rawId : null;
  const createNew = form.get(VENDOR_PICK_FIELDS.createNew) === "1";
  return {
    id,
    createNew,
    preserve: { ...(id ? { pu_vid: id } : {}), ...(createNew ? { pu_vnew: "1" } : {}) },
  };
}
