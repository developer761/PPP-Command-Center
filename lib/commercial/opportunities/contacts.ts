import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logDelete, logUpdate } from "@/lib/commercial/audit-log";
import { isContactRole, type ContactRole } from "@/lib/commercial/contacts/roles";

/**
 * Contacts on a JOB.
 *
 * Stephanie 2026-08-13: *"each job may have different contacts for site supers,
 * pms, apms, estimators, etc."* The account's contacts are the GC's office —
 * estimating, AP, whoever sends bid invites. The people you deal with once work
 * starts are assigned per project, they differ between jobs at the same
 * builder, and they change mid-job.
 *
 * The PERSON stays in `commercial_contacts` and is reused, so the same
 * superintendent across three jobs is one record with one phone number rather
 * than three that drift apart. The ROLE lives on the link, because the same
 * person is a PM here and a superintendent there.
 */

export type OpportunityContact = {
  id: string;
  contact_id: string;
  role: ContactRole;
  is_primary: boolean;
  notes: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
};

type Row = {
  id: string;
  contact_id: string;
  role: string;
  is_primary: boolean;
  notes: string | null;
};

/**
 * Everyone on this job. Primary first, then by role, then by name — the
 * "Attention" contact is the one people look for, so it does not sit
 * alphabetically in the middle of the list.
 */
export async function listOpportunityContacts(
  opportunityId: string
): Promise<OpportunityContact[]> {
  const sb = commercialDb();
  const { data: links } = await sb
    .from("commercial_opportunity_contacts")
    .select("id, contact_id, role, is_primary, notes")
    .eq("opportunity_id", opportunityId);
  const rows = (links ?? []) as Row[];
  if (rows.length === 0) return [];

  const { data: people } = await sb
    .from("commercial_contacts")
    .select("id, full_name, email, phone, title")
    .in("id", [...new Set(rows.map((r) => r.contact_id))])
    .is("deleted_at", null);
  const byId = new Map(
    ((people ?? []) as { id: string; full_name: string; email: string | null; phone: string | null; title: string | null }[]).map(
      (p) => [p.id, p]
    )
  );

  return rows
    // A contact soft-deleted out from under the link would otherwise render as
    // a blank row with a phone icon and no name.
    .filter((r) => byId.has(r.contact_id))
    .map((r) => {
      const p = byId.get(r.contact_id)!;
      return {
        id: r.id,
        contact_id: r.contact_id,
        role: (isContactRole(r.role) ? r.role : "other") as ContactRole,
        is_primary: r.is_primary,
        notes: r.notes,
        full_name: p.full_name,
        email: p.email,
        phone: p.phone,
        title: p.title,
      };
    })
    .sort(
      (a, b) =>
        Number(b.is_primary) - Number(a.is_primary) ||
        a.role.localeCompare(b.role) ||
        a.full_name.localeCompare(b.full_name)
    );
}

export async function addOpportunityContact(input: {
  opportunityId: string;
  contactId: string;
  role: string;
  isPrimary?: boolean;
  notes?: string | null;
  actorUserId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isContactRole(input.role)) return { ok: false, error: "Pick a role." };
  const sb = commercialDb();

  if (input.isPrimary) {
    const cleared = await clearPrimary(input.opportunityId);
    if (!cleared.ok) return cleared;
  }

  const row = {
    opportunity_id: input.opportunityId,
    contact_id: input.contactId,
    role: input.role,
    is_primary: Boolean(input.isPrimary),
    notes: input.notes?.trim() || null,
    created_by_user_id: input.actorUserId,
  };
  const { data, error } = await sb
    .from("commercial_opportunity_contacts")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    // The UNIQUE (opportunity, contact, role) is a feature, not a failure:
    // saying "already on this job" is more use than a Postgres error string.
    if (error.code === "23505") {
      return { ok: false, error: "That person is already on this job in that role." };
    }
    return { ok: false, error: error.message };
  }
  await logInsert(
    "commercial_opportunity_contacts",
    (data as { id: string }).id,
    row,
    input.actorUserId
  ).catch(() => undefined);
  return { ok: true };
}

export async function removeOpportunityContact(
  linkId: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_contacts")
    .select("*")
    .eq("id", linkId)
    .maybeSingle();
  const { error } = await sb.from("commercial_opportunity_contacts").delete().eq("id", linkId);
  if (error) return { ok: false, error: error.message };
  if (before) {
    await logDelete(
      "commercial_opportunity_contacts",
      linkId,
      before as Record<string, unknown>,
      actorUserId
    ).catch(() => undefined);
  }
  return { ok: true };
}

/**
 * Make one link the "Attention" contact — the person the proposal is addressed
 * to (Stephanie: *"Attention Contact? How do I edit that"*).
 *
 * Clears the previous one first. The database also enforces one-per-job with a
 * partial unique index, because two primaries is the sort of thing that only
 * becomes visible on a printed proposal in front of a customer.
 */
export async function setPrimaryOpportunityContact(
  opportunityId: string,
  linkId: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cleared = await clearPrimary(opportunityId);
  if (!cleared.ok) return cleared;
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_opportunity_contacts")
    .update({ is_primary: true })
    .eq("id", linkId)
    .eq("opportunity_id", opportunityId);
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_opportunity_contacts",
    linkId,
    {},
    { is_primary: true },
    actorUserId
  ).catch(() => undefined);
  return { ok: true };
}

async function clearPrimary(
  opportunityId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_opportunity_contacts")
    .update({ is_primary: false })
    .eq("opportunity_id", opportunityId)
    .eq("is_primary", true);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
