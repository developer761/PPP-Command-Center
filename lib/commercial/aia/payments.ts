import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logDelete } from "@/lib/commercial/audit-log";

/**
 * Money received against an AIA application.
 *
 * Stephanie 2026-09-24: *"At times we would need to record multiple payments
 * against 1 AIA."* And the day before, on an AIA-billed job: *"when I went
 * into record the payment, it didn't show up on the list because it was billed
 * as AIA. Even on the open AIA's."*
 *
 * Before this, an application had a `status` and nothing else. Marking it
 * `paid` asserted that the whole of G702 line 6 had arrived — on a date nobody
 * recorded, by a method nobody recorded, in one lump. The rollups then
 * inferred "collected" from that flag. They got the TOTAL right, which is why
 * nothing looked broken, and lost every other fact about the payment. There
 * was no way to say a GC paid half of Application 3, which on a $1.2M job
 * across four buildings is not an edge case.
 *
 * Two deliberate choices:
 *
 *  · NO `paid_cents` CACHE on the application. The sum of the rows IS what was
 *    collected. A cached total is one more number that can disagree with the
 *    rows beneath it, and the status flag disagreeing with reality is the bug
 *    this replaces.
 *  · The application's `status` FOLLOWS the payments rather than leading them.
 *    Recording enough to cover line 6 marks it paid; removing a payment puts
 *    it back to submitted. Nobody has to remember to flip a switch after
 *    typing a cheque number, which is exactly the kind of second step that
 *    gets skipped and leaves the books wrong.
 *
 * Every function here tolerates the migration not being applied yet
 * (`20260924090000_aia_payments.sql`) — there is no migration runner in this
 * repo, SQL is pasted in by hand, and a screen that 500s in the window between
 * a deploy and a paste is worse than one that shows no payments.
 */

export type AiaPayment = {
  id: string;
  application_id: string;
  amount_cents: number;
  paid_at: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  lien_waiver_document_id: string | null;
  deposited_at: string | null;
  recorded_by_user_id: string | null;
  created_at: string;
};

export type Result<T> =
  | { ok: true; value: T; capped?: boolean; requested_cents?: number }
  | { ok: false; error: string };

/** The table is missing — migration 20260924090000 has not been pasted in. */
function isMissingTable(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    /commercial_aia_payments/i.test(error.message ?? "") &&
      /(does not exist|schema cache|Could not find)/i.test(error.message ?? "")
  );
}

export async function listAiaPayments(applicationId: string): Promise<AiaPayment[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_aia_payments")
    .select("*")
    .eq("application_id", applicationId)
    .is("deleted_at", null)
    .order("paid_at", { ascending: true });
  if (error) {
    if (!isMissingTable(error))
      console.warn("[aia/payments] list failed:", error.message);
    return [];
  }
  return (data ?? []) as AiaPayment[];
}

/** Payments for many applications at once — one query, not N. */
export async function listAiaPaymentsByApplication(
  applicationIds: string[],
): Promise<Map<string, AiaPayment[]>> {
  const out = new Map<string, AiaPayment[]>();
  if (applicationIds.length === 0) return out;
  const sb = commercialDb();
  // Chunked: an `.in()` of UUIDs runs out of URL long before it runs out of
  // rows, which is how a list silently returns a prefix of the truth.
  for (let i = 0; i < applicationIds.length; i += 200) {
    const chunk = applicationIds.slice(i, i + 200);
    const { data, error } = await sb
      .from("commercial_aia_payments")
      .select("*")
      .in("application_id", chunk)
      .is("deleted_at", null)
      .order("paid_at", { ascending: true });
    if (error) {
      if (!isMissingTable(error))
        console.warn("[aia/payments] batch list failed:", error.message);
      return out;
    }
    for (const p of (data ?? []) as AiaPayment[]) {
      const list = out.get(p.application_id) ?? [];
      list.push(p);
      out.set(p.application_id, list);
    }
  }
  return out;
}

export function sumAiaPayments(payments: AiaPayment[]): number {
  return payments.reduce((n, p) => n + Number(p.amount_cents ?? 0), 0);
}

export type RecordAiaPaymentInput = {
  application_id: string;
  amount_cents: number;
  paid_at?: string | null;
  method?: string | null;
  reference?: string | null;
  notes?: string | null;
  recorded_by_user_id: string;
};

export async function recordAiaPayment(
  input: RecordAiaPaymentInput,
): Promise<Result<AiaPayment>> {
  if (!Number.isFinite(input.amount_cents) || Math.round(input.amount_cents) <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." };
  }
  const sb = commercialDb();

  /**
   * CAP AT WHAT THE CERTIFICATE ASKS FOR.
   *
   * The invoice ledger this is modelled on caps a payment to the balance and
   * reports `capped` so the UI can say so. Without the same rule here, one
   * extra zero makes collected exceed billed on the deal P&L with no credit
   * shown anywhere — and on a G702 that number is what a GC statement asserts.
   *
   * Capping rather than refusing, for the same reason the invoice path does:
   * the money HAS arrived, and rejecting the entry leaves the books further
   * from the truth than recording what the certificate can hold. The overage
   * belongs on the next application, and the caller is told.
   */
  const due = await applicationPeriodDueCents(input.application_id);
  const already = sumAiaPayments(await listAiaPayments(input.application_id));
  const room = due > 0 ? Math.max(0, due - already) : null;
  const requested = Math.round(input.amount_cents);
  if (room === 0) {
    return {
      ok: false,
      error: "This certificate is already paid in full. Record the payment on the next application.",
    };
  }
  const amount = room == null ? requested : Math.min(requested, room);

  const { data, error } = await sb
    .from("commercial_aia_payments")
    .insert({
      application_id: input.application_id,
      amount_cents: amount,
      paid_at: input.paid_at ?? new Date().toISOString(),
      method: input.method?.trim() || null,
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      recorded_by_user_id: input.recorded_by_user_id,
    })
    .select("*")
    .maybeSingle();
  if (error || !data) {
    if (isMissingTable(error))
      return {
        ok: false,
        error:
          "AIA payments aren't switched on yet — the database migration still needs to be applied.",
      };
    return { ok: false, error: error?.message ?? "insert_failed" };
  }
  const row = data as AiaPayment;
  await logInsert("commercial_aia_payments", row.id, row, input.recorded_by_user_id);
  await syncApplicationStatusToPayments(input.application_id, input.recorded_by_user_id);
  return {
    ok: true,
    value: row,
    capped: amount !== requested,
    requested_cents: requested,
  };
}

export async function deleteAiaPayment(
  paymentId: string,
  actorUserId: string,
): Promise<Result<{ application_id: string }>> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_aia_payments")
    .select("*")
    .eq("id", paymentId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "payment_not_found" };
  const { error } = await sb
    .from("commercial_aia_payments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", paymentId)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  // Soft delete, logged — the same rule the invoice ledger now follows after a
  // $286,695 invoice was removed with no audit row behind it.
  await logDelete("commercial_aia_payments", paymentId, before, actorUserId);
  const appId = (before as AiaPayment).application_id;
  await syncApplicationStatusToPayments(appId, actorUserId);
  return { ok: true, value: { application_id: appId } };
}

/**
 * Make the application's status agree with the money on it.
 *
 * Paid in full (≥ G702 line 6) → `paid`. Anything less on an issued
 * application → `submitted`, so a part-paid certificate still reads as
 * outstanding and keeps showing up in AR, which is the whole point of
 * recording it.
 *
 * A DRAFT is never promoted: money against an uncertified application is a
 * data-entry mistake, not a reason to certify it on the operator's behalf.
 * Best-effort throughout — a status that fails to move must not lose the
 * payment that was just typed.
 */
async function syncApplicationStatusToPayments(
  applicationId: string,
  actorUserId: string,
): Promise<void> {
  try {
    const sb = commercialDb();
    const { data: app } = await sb
      .from("commercial_aia_applications")
      .select("id, status")
      .eq("id", applicationId)
      .maybeSingle();
    const status = (app as { status?: string } | null)?.status;
    if (!status || status === "draft") return;

    const payments = await listAiaPayments(applicationId);
    const paid = sumAiaPayments(payments);

    // WHAT THIS CERTIFICATE ASKED FOR — its own period, not the whole job.
    //
    // G702 line 6 is CUMULATIVE: it carries every prior period. Comparing
    // payments against it meant a certificate could be paid in full and still
    // read as outstanding, because the payments covered THIS period while the
    // denominator was the entire job to date. On AIREF Application 3 that was
    // $75,129.18 of payments measured against $141,962.49.
    //
    // The amount due on a certificate is the step up from the one before it —
    // the same quantity G702 line 7 prints as CURRENT PAYMENT DUE.
    const due = await applicationPeriodDueCents(applicationId);

    // A zero or unresolvable certificate cannot tell us "paid in full", so
    // leave the status alone rather than guess from an unknown denominator.
    if (due <= 0) return;

    /**
     * NEVER DEMOTE ON AN EMPTY LEDGER.
     *
     * An application marked paid BEFORE payment records existed carries no
     * rows, and that flag is the only evidence the money arrived. Removing the
     * last recorded payment from such an application used to demote it to
     * `submitted` — which erased that evidence and, because the legacy
     * inference keys off the paid flag, took the whole amount out of collected.
     *
     * Reproduced on AIREF Building #1 while checking whether Stephanie could
     * back-fill a cheque onto Application 2: adding the payment was safe, and
     * removing it again left the job reading $0.00 collected against
     * $189,434.20 billed. The status had to be put back by hand.
     *
     * So an empty ledger means "nothing recorded here", not "not paid". The
     * status only moves DOWN when a payment is removed from a set that still
     * has payments in it — the case where the ledger genuinely is the record.
     */
    if (paid === 0 && status === "paid" && !(await everHadPayments(applicationId))) return;

    const next = paid >= due ? "paid" : "submitted";
    if (next === status) return;
    const { updateAiaApplication } = await import("./db");
    const res = await updateAiaApplication(applicationId, { status: next as never }, actorUserId);
    // SAY SO WHEN IT IS REFUSED. This threw the Result away, so when
    // updateAiaApplication blocked the paid → submitted move the status simply
    // stayed `paid` with no money behind it, silently, and every report went on
    // counting it as collected. A status that cannot follow the payments is the
    // exact failure this function exists to prevent, so it must never be
    // invisible.
    if (!res.ok) {
      console.error(
        `[aia/payments] application ${applicationId} could not move to ${next}: ${res.error}`,
      );
    }
  } catch (e) {
    console.warn(
      "[aia/payments] status sync failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Has a payment EVER been recorded here, including ones since removed?
 *
 * This is what separates the two reasons an application can sit at `paid`
 * with an empty ledger. A certificate flagged paid before payment records
 * existed has never had a row, and that flag is the only evidence the money
 * arrived — demoting it erases the evidence and takes the amount out of
 * collected. A certificate that was paid by rows which have since been
 * removed HAS had rows, so the ledger is the record and it must go back to
 * outstanding.
 *
 * Without the distinction the guard over-applied: removing the payment from a
 * certificate that had just been paid left it reading `paid` with no money
 * behind it, which is the original bug wearing the fix's clothes.
 */
async function everHadPayments(applicationId: string): Promise<boolean> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_aia_payments")
    .select("id")
    .eq("application_id", applicationId)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

/**
 * What ONE certificate asks for — G702 line 6 minus the prior application's
 * line 6, which is the "CURRENT PAYMENT DUE" figure printed on the document.
 *
 * Exported because two places need it and they must not drift: the status
 * sync above, and the Accounting payment picker's "outstanding" figure. A
 * certificate that reads $75,129.18 outstanding in the picker and needs
 * $141,962.49 to mark itself paid is a platform arguing with itself.
 */
export async function applicationPeriodDueCents(applicationId: string): Promise<number> {
  const sb = commercialDb();
  const { data: app } = await sb
    .from("commercial_aia_applications")
    .select("id, opportunity_id, application_number")
    .eq("id", applicationId)
    .maybeSingle();
  if (!app) return 0;
  const row = app as { opportunity_id: string; application_number: number };

  const { resolveG702 } = await import("./db");
  const mine = Math.round((await resolveG702(applicationId))?.totalEarnedLessRetainageCents ?? 0);
  if (mine <= 0) return 0;

  // The nearest ISSUED application below this one. A draft has certified
  // nothing, so it cannot be what the GC already paid against.
  const { data: priorRows } = await sb
    .from("commercial_aia_applications")
    .select("id, application_number")
    .eq("opportunity_id", row.opportunity_id)
    .lt("application_number", row.application_number)
    .in("status", ["submitted", "paid"])
    .is("deleted_at", null)
    .order("application_number", { ascending: false })
    .limit(1);
  const prior = (priorRows ?? [])[0] as { id: string } | undefined;
  const priorCents = prior
    ? Math.round((await resolveG702(prior.id))?.totalEarnedLessRetainageCents ?? 0)
    : 0;
  return Math.max(0, mine - priorCents);
}
