import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";

/**
 * Helpers for commercial_contacts + commercial_account_contacts (junction).
 *
 * A contact is a person (name, email, phone). A contact is attached to
 * an Account via one or more rows in commercial_account_contacts, each
 * carrying a role. The SAME person CAN have multiple roles on the SAME
 * account (e.g. Decision Maker AND Billing). One row per (account,
 * contact, role) — UNIQUE constraint enforces this in the DB.
 */

export const CONTACT_ROLES = [
  "decision_maker",
  "estimator",
  "pm",
  "superintendent",
  "ap",
  "billing",
  "site",
  "other",
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export function roleLabel(role: ContactRole): string {
  return {
    decision_maker: "Decision Maker",
    estimator: "Estimator",
    pm: "PM",
    superintendent: "Superintendent",
    ap: "AP",
    billing: "Billing",
    site: "Site",
    other: "Other",
  }[role];
}

export type CommercialContact = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type AccountContactRow = {
  account_contact_id: string;
  contact: CommercialContact;
  role: ContactRole;
  is_default_for: string | null;
  notes: string | null;
  is_primary: boolean;
  last_contacted_at: string | null;
};

/**
 * Load all contacts attached to an account, grouped by person.
 *
 * Returns one row per UNIQUE contact with their list of roles.
 * The same person showing up under N roles becomes ONE entry with N roles
 * — easier for the UI to render the "Sarah Lee · Decision Maker + Billing"
 * row instead of two separate rows.
 */
export type ContactAttachment = {
  account_contact_id: string;
  role: ContactRole;
  is_default_for: string | null;
  notes: string | null;
  is_primary: boolean;
  last_contacted_at: string | null;
};

export async function listAccountContacts(accountId: string): Promise<
  Array<{
    contact: CommercialContact;
    attachments: ContactAttachment[];
  }>
> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_contacts")
    .select(
      "id, role, is_default_for, notes, is_primary, last_contacted_at, contact:commercial_contacts(*)"
    )
    .eq("account_id", accountId);

  if (error) {
    console.warn("[commercial/accounts/contacts] list failed:", error.message);
    return [];
  }

  const byContactId = new Map<
    string,
    {
      contact: CommercialContact;
      attachments: ContactAttachment[];
    }
  >();

  type Row = {
    id: string;
    role: ContactRole;
    is_default_for: string | null;
    notes: string | null;
    is_primary: boolean | null;
    last_contacted_at: string | null;
    // Supabase typegen may surface the joined row as either object or array; we normalize below.
    contact: CommercialContact | CommercialContact[] | null;
  };
  for (const raw of (data ?? []) as unknown as Row[]) {
    const contact = Array.isArray(raw.contact) ? raw.contact[0] ?? null : raw.contact;
    if (!contact) continue;
    if (contact.deleted_at) continue;
    const attachment: ContactAttachment = {
      account_contact_id: raw.id,
      role: raw.role,
      is_default_for: raw.is_default_for,
      notes: raw.notes,
      is_primary: raw.is_primary ?? false,
      last_contacted_at: raw.last_contacted_at,
    };
    const existing = byContactId.get(contact.id);
    if (existing) {
      existing.attachments.push(attachment);
    } else {
      byContactId.set(contact.id, {
        contact,
        attachments: [attachment],
      });
    }
  }

  // Stable display order: primary contact first, then alphabetical by name.
  return Array.from(byContactId.values()).sort((a, b) => {
    const aPrimary = a.attachments.some((x) => x.is_primary);
    const bPrimary = b.attachments.some((x) => x.is_primary);
    if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
    return a.contact.full_name.localeCompare(b.contact.full_name);
  });
}

/** Get the primary contact for an account, if any. Returns the
 *  contact + the junction row id. Used by the detail header so the
 *  quick-email button can fire a mailto: in one click. */
export async function getPrimaryContact(accountId: string): Promise<
  { contact: CommercialContact; account_contact_id: string; role: ContactRole } | null
> {
  const sb = commercialDb();
  // Filter soft-deleted contacts at the join level for explicitness —
  // we also re-check `contact.deleted_at` below as a belt-and-braces
  // guard in case the join shape changes upstream.
  const { data } = await sb
    .from("commercial_account_contacts")
    .select("id, role, contact:commercial_contacts!inner(*)")
    .eq("account_id", accountId)
    .eq("is_primary", true)
    .is("contact.deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  type Row = {
    id: string;
    role: ContactRole;
    contact: CommercialContact | CommercialContact[] | null;
  };
  const row = data as unknown as Row;
  const contact = Array.isArray(row.contact) ? row.contact[0] ?? null : row.contact;
  if (!contact || contact.deleted_at) return null;
  return { contact, account_contact_id: row.id, role: row.role };
}

/** Toggle the primary flag on a single attachment row. Atomic-ish: we
 *  clear any other primary on this account first, then flip the target.
 *  At most one primary per account is also enforced by a partial UNIQUE
 *  INDEX (migration 026) as belt-and-braces. */
export async function setPrimaryContact(
  accountId: string,
  accountContactId: string,
  makePrimary: boolean,
  actingUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  // Verify the junction row belongs to this account.
  const { data: row } = await sb
    .from("commercial_account_contacts")
    .select("*")
    .eq("id", accountContactId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Contact not found on this account." };

  if (makePrimary) {
    // Demote any current primary first so the partial UNIQUE INDEX
    // doesn't reject the new one.
    const { data: existingPrimary } = await sb
      .from("commercial_account_contacts")
      .select("*")
      .eq("account_id", accountId)
      .eq("is_primary", true)
      .maybeSingle();
    if (existingPrimary) {
      const beforeRow = existingPrimary as { id: string };
      const { data: demoted } = await sb
        .from("commercial_account_contacts")
        .update({ is_primary: false })
        .eq("id", beforeRow.id)
        .select("*")
        .single();
      if (demoted) {
        await logUpdate(
          "commercial_account_contacts",
          beforeRow.id,
          existingPrimary,
          demoted,
          actingUserId
        );
      }
    }
  }

  const { data: after, error } = await sb
    .from("commercial_account_contacts")
    .update({ is_primary: makePrimary })
    .eq("id", accountContactId)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  await logUpdate(
    "commercial_account_contacts",
    accountContactId,
    row,
    after,
    actingUserId
  );
  return { ok: true };
}

/** Record that someone from PPP just touched this contact (sent an
 *  email, made a call, etc.). Powers the "last touched" badge per
 *  contact + the "haven't heard in 60d" sort on the list page. */
export async function touchContact(
  accountId: string,
  accountContactId: string,
  actingUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_account_contacts")
    .select("*")
    .eq("id", accountContactId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Contact not found on this account." };
  const { data: after, error } = await sb
    .from("commercial_account_contacts")
    .update({
      last_contacted_at: new Date().toISOString(),
      last_contacted_by_user_id: actingUserId ?? null,
    })
    .eq("id", accountContactId)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_account_contacts",
    accountContactId,
    before,
    after,
    actingUserId
  );
  return { ok: true };
}

export type AddContactInput = {
  account_id: string;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  role: ContactRole;
  is_default_for?: string | null;
  notes?: string | null;
  created_by_user_id?: string | null;
};

/**
 * Add a contact to an account.
 *
 * Idempotent on email: if a contact with this email already exists, attach
 * THAT contact instead of creating a duplicate (people who already work for
 * one account may join a second account at PPP). The role row in
 * commercial_account_contacts is always created fresh.
 *
 * Returns the new account_contact junction row's id.
 */
export async function addContactToAccount(input: AddContactInput): Promise<
  { ok: true; account_contact_id: string } | { ok: false; error: string }
> {
  if (!input.full_name?.trim()) return { ok: false, error: "Name is required." };
  const sb = commercialDb();

  // Guard against attaching to a soft-deleted account — otherwise a
  // restored account would resurrect with phantom contacts.
  const { data: account } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", input.account_id)
    .maybeSingle();
  if (!account || account.deleted_at) {
    return { ok: false, error: "Account not found." };
  }

  let contactId: string | null = null;

  if (input.email?.trim()) {
    const { data: existing } = await sb
      .from("commercial_contacts")
      .select("id")
      .eq("email", input.email.trim().toLowerCase())
      .is("deleted_at", null)
      .maybeSingle();
    if (existing) contactId = (existing as { id: string }).id;
  }

  if (!contactId) {
    const { data, error } = await sb
      .from("commercial_contacts")
      .insert({
        full_name: input.full_name.trim(),
        email: input.email?.trim().toLowerCase() || null,
        phone: input.phone?.trim() || null,
        title: input.title?.trim() || null,
        created_by_user_id: input.created_by_user_id ?? null,
      })
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };
    const newContact = data as CommercialContact;
    contactId = newContact.id;
    await logInsert("commercial_contacts", contactId, newContact, input.created_by_user_id);
  }

  // Now attach the role. If this (account, contact, role) already exists,
  // surface a friendly error rather than crashing on the UNIQUE constraint.
  const { data: ac, error: acError } = await sb
    .from("commercial_account_contacts")
    .insert({
      account_id: input.account_id,
      contact_id: contactId,
      role: input.role,
      is_default_for: input.is_default_for ?? null,
      notes: input.notes?.trim() || null,
    })
    .select("*")
    .single();

  if (acError) {
    if (acError.message.toLowerCase().includes("duplicate")) {
      return { ok: false, error: "This contact is already attached to this account with that role." };
    }
    return { ok: false, error: acError.message };
  }

  const row = ac as { id: string };
  await logInsert("commercial_account_contacts", row.id, ac, input.created_by_user_id);
  return { ok: true, account_contact_id: row.id };
}

/**
 * Detach a contact role from an account (deletes the junction row).
 *
 * Security fix 2026-06-24: now requires accountId and double-scopes the
 * row lookup + delete. Without this, a hand-crafted POST with a foreign
 * account_contact_id could detach a contact from a different account.
 */
export async function detachContactFromAccount(
  accountId: string,
  account_contact_id: string,
  deletedByUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_account_contacts")
    .select("*")
    .eq("id", account_contact_id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Attachment not found." };

  const { error } = await sb
    .from("commercial_account_contacts")
    .delete()
    .eq("id", account_contact_id)
    .eq("account_id", accountId);
  if (error) return { ok: false, error: error.message };

  await logDelete("commercial_account_contacts", account_contact_id, before, deletedByUserId);
  return { ok: true };
}
