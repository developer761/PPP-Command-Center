import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

import { getSalesforceClient } from "@/lib/salesforce/client";
import { assertSalesforceId } from "@/lib/salesforce/soql";
import { logSfCreate, writeSf } from "@/lib/salesforce/writeback";

/**
 * A change order approved (or reversed) in the Commercial Command Center, put
 * into Salesforce.
 *
 * Karan, 2026-10-15: *"go and add the change orders too."* A change order
 * approved after the sale moves the sale's value, so it has to follow the sale
 * through the same queue and the same tick — otherwise Katie's total is right
 * on the day of the win and wrong a week later. The last four reconciliation
 * differences, closed on 2026-10-14, were exactly this.
 *
 * THE MONEY GOES ON THE CHANGE ORDER, NOT THE WORK ORDER
 *
 *   ChangeOrder__c.CostChange__c
 *     └→ WorkOrder.TotalChangeOrder__c                  rollup
 *          └→ WorkOrder.Quoted_Subtotal_with_Change_Order__c   formula
 *               └→ Opportunity                           flow
 *
 * Proven in the sandbox on 2026-10-14: one $1,111.11 change order moved its
 * work order from $12,345.67 to $13,456.78 on its own. So this creates the
 * record and lets the org do the arithmetic — it never writes a money field on
 * the work order or the opportunity.
 *
 * A REVERSAL IS A STATUS WRITE, NOT A DELETE
 *
 * Measured against 18 live work orders on 2026-10-15: the rollup counts
 * approved statuses ONLY. Every work order carrying a `Denied` or `Pending
 * Approval` change order rolled up the approved ones and nothing else — a
 * $800 Denied change order contributes $0. And `ChangeOrder__c` is not
 * deletable at all (`describe().deletable === false`). So when somebody here
 * declines or deletes a change order that was already pushed, this sets
 * `Status__c = 'Denied'` and the money leaves Katie's total by the same route
 * it arrived.
 */

/** Salesforce money is dollars; we keep cents. */
const dollars = (cents: number | null | undefined) => Math.round(Number(cents ?? 0)) / 100;
const cents = (d: number | null | undefined) => Math.round(Number(d ?? 0) * 100);

/**
 * The reason code. Katie has not picked one — the candidates are in §2d of the
 * plan — so this is the neutral one, verified accepted in the sandbox on
 * 2026-10-14. Salesforce's own default is "Client changed mind", a claim about
 * her GCs that nothing here supports, which is why the field is always sent
 * rather than left to default.
 */
export const CHANGE_ORDER_REASON = "Scope change";

/**
 * Verified by experiment rather than assumed: written on a real sandbox change
 * order, "Approved" held, no flow rewrote it, and the rollup moved by exactly
 * the amount. "Approved-Auto" is the org-wide majority but is evidently set by
 * a flow on another path.
 */
export const APPROVED_STATUS = "Approved";
/** The status that takes the money back out. See the docblock above. */
export const DENIED_STATUS = "Denied";

/** Every status Salesforce's rollup counts. Measured, not guessed. */
export const APPROVED_IN_SF = ["Approved", "Approved-Auto", "Legacy Import (Approved)"];

/**
 * Rows the importer invented to carry a Salesforce TOTAL across, which are not
 * change orders at all.
 *
 * 🔴 PUSHING ONE WOULD ADD MONEY SALESFORCE ALREADY HOLDS. LMJ Cipla's single
 * $31,127.09 row stands for SEVEN Salesforce records; across the book they
 * carry ~$176,000. They are identified by title and never pushed.
 */
export const ROLLUP_TITLE = /^approved change orders$/i;

/**
 * The import-map entity for a change order THIS feature pushed.
 *
 * 🔴 DELIBERATELY NOT `change_order`, which the importer already uses for
 * something else: there, `sf_id` is a WORK ORDER id and the row means "this
 * Command Center change order is Salesforce's per-job total". Reusing it would
 * do two kinds of damage at once — `liveHandMadeChangeOrderDeals` would stop
 * seeing the pushed row as hand-made and re-enable inserting Salesforce's
 * total on top of it, and `restampEntity` would treat it as the importer's own.
 *
 * Here `sf_id` is the `ChangeOrder__c` id and `row_id` is the Command Center
 * change order. The importer never loads this entity (every read of the map is
 * `.eq("entity", …)`), and `startsWith("change_order:")` does not match
 * `change_order_record:` — checked, not assumed.
 */
export const CO_MAP_ENTITY = "change_order_record";

/**
 * A person's answer to "is this a genuine second change order at the same
 * amount?" — recorded so the tick stops asking.
 *
 * 🔴 WITHOUT THIS THE GUARD LOSES MONEY. Refusing to adopt a Salesforce record
 * that already belongs to another change order is right: the alternative was
 * two Command Center rows taking turns stealing one link, one of them never
 * written to Salesforce at all. But a HOLD with no way out is not better. Two
 * approved change orders on one deal for the same amount is a live pattern
 * here, and the second one would have held for ever — `markHeld` does not
 * count attempts, so it never becomes "stopped asking", so the review screen's
 * retry button never appears, and the sweep skips anything still pending.
 * Quietly, permanently, that work would never reach `TotalChangeOrder__c`.
 *
 * `row_id` is the Command Center change order and `sf_id` is a marker rather
 * than a Salesforce record, so it cannot collide with a real link.
 */
export const CO_FORCE_NEW_ENTITY = "change_order_force_new";
export const coForceNewMarker = (changeOrderId: string) => `force:${changeOrderId}`;

export type ChangeOrderSyncOutcome = {
  changeOrderId: string;
  label: string;
  action: "created" | "updated" | "adopted" | "nothing" | "held" | "failed";
  /** Why, in words somebody reading the review queue can act on. */
  why: string;
  sfId: string | null;
  steps: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  error?: string;
  /**
   * For `held`: what it is waiting for. `event` clears on its own (the sale
   * reaching Salesforce, the org making a work order) and is re-checked on the
   * back-off; `person` is parked until somebody acts. See `markHeld`.
   */
  waitsFor?: "event" | "person";
};

type Ctx = {
  conn: Awaited<ReturnType<typeof getSalesforceClient>>;
  actorUserId: string | null;
  apply: boolean;
};

function admin() {
  return createSupabaseAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The Command Center's own view of a change order, as this module needs it. */
export type LocalChangeOrder = {
  id: string;
  opportunityId: string;
  coNumber: number | null;
  title: string | null;
  description: string | null;
  amountCents: number;
  /** TRUE when Salesforce should be counting this money. */
  shouldCount: boolean;
  dealTitle: string;
  /** The deal itself has been deleted here. */
  dealDeleted: boolean;
};

/**
 * What state does Salesforce need to be in for this change order?
 *
 * Pure, and separated from the writing for the reason every rule in this
 * feature is: the reversal case is the one nobody will exercise by hand before
 * it matters. A change order that was approved, pushed, and then declined or
 * deleted must take its money back out of Katie's total — and the only way to
 * be sure of that is to decide it in a function a test can drive.
 */
export function desiredSalesforceStatus(local: { shouldCount: boolean }): string {
  return local.shouldCount ? APPROVED_STATUS : DENIED_STATUS;
}

/** Is Salesforce currently counting this record's money? */
export function salesforceCounts(status: string | null | undefined): boolean {
  return APPROVED_IN_SF.includes(String(status ?? ""));
}

/**
 * Does Salesforce already hold the state we want? Pure, so "do nothing" is a
 * decision with a test rather than a branch nobody checked.
 *
 * An update that changes no field is not free here: it still enters every flow
 * on the object, including the unfiltered quota-points one.
 */
export function changeOrderNeedsWrite(
  sf: { status: string | null; costChange: number | null },
  local: { amountCents: number; shouldCount: boolean },
): boolean {
  if (salesforceCounts(sf.status) !== local.shouldCount) return true;
  // A denied record's amount is not worth a write — the rollup ignores it
  // either way, and rewriting it would re-enter every flow for nothing.
  if (!local.shouldCount) return false;
  return cents(sf.costChange) !== Math.round(local.amountCents);
}

/** What the write-back puts in `Notes__c` for a change order — and so what identifies one it made. */
export function changeOrderNotes(local: { title: string | null; description: string | null }): string | null {
  return [local.title, local.description].filter(Boolean).join(" — ").slice(0, 2000) || null;
}

export type SfChangeOrderRow = {
  Id: string;
  Name: string;
  CostChange__c: number | null;
  Status__c: string | null;
  Notes__c?: string | null;
};

export type UnlinkedPlan =
  | { kind: "recover"; sf: SfChangeOrderRow; why: string }
  | { kind: "adopt"; sf: SfChangeOrderRow; why: string }
  | { kind: "create"; why: string }
  | { kind: "nothing"; why: string }
  | { kind: "hold"; why: string };

/**
 * A change order with no link row: is it already in Salesforce, and if so
 * which record — or is it genuinely new?
 *
 * PURE, because each of its wrong answers creates a second ChangeOrder__c for
 * one piece of work, doubles `TotalChangeOrder__c`, and nothing in Salesforce
 * refuses it (the object has no unique external id). The I/O around it THROWS
 * on any failed read before this runs (F23 c), so "nothing found" here always
 * means nothing exists, never "the read failed".
 *
 * THE ORDER IS THE RULE:
 *
 *  1. RECOVER a record this write-back already made for THIS change order —
 *     found by the id its own queue history recorded, or by the exact
 *     `Notes__c` it sends. A lost link row used to fall through to "create",
 *     and with a person's force-new marker still standing (F23 d) it did so on
 *     every loss. This is checked before anything else, the marker included.
 *  2. Never adopt a record already linked to another change order here.
 *  3. Never turn a record Tomco's org DENIED back on.
 *  4. Adopt the one record at this amount; hold on two or more.
 *  5. Nothing to create for a change order reversed here.
 *  6. 🔴 HOLD when Salesforce has approved change-order money on this job that
 *     nobody here stands for. That is what VCA West Islip was: the migrated
 *     rollup row standing for CO-32409 was deleted while its work was
 *     re-entered as itemised change orders, and the next push created
 *     CO-32669 on top of CO-32409 — $14,625 counted twice. Whether a new
 *     change order is ADDITIONAL to that money or the same work itemised is
 *     not a question an amount can answer.
 *  7. Otherwise create.
 *
 * A person's "it is a genuine second one" (`personSaysItIsNew`) lifts 4 and 6,
 * never 1–3.
 */
export function planUnlinkedChangeOrder(input: {
  local: { id: string; amountCents: number; shouldCount: boolean; title: string | null; description: string | null };
  /** Every ChangeOrder__c on the deal's live work orders. */
  sfCos: SfChangeOrderRow[];
  /** sf_id → row_id, for every link row naming one of `sfCos`. */
  claimedBy: Map<string, string>;
  /** Salesforce ids this change order's own queue history says the write-back created. */
  createdForThis: Set<string>;
  personSaysItIsNew: boolean;
  /** Live, approved migrated rollup rows on this deal — they stand for Salesforce records. */
  liveRollupCents: number;
}): UnlinkedPlan {
  const { local, sfCos, claimedBy } = input;
  const amount = Math.round(local.amountCents);
  const free = (x: SfChangeOrderRow) => !claimedBy.has(x.Id) || claimedBy.get(x.Id) === local.id;
  const usd = (c: number) => (c / 100).toFixed(2);

  // 1 ── ours, lost ──────────────────────────────────────────────────────────
  const notes = changeOrderNotes(local);
  const ours = sfCos.filter((x) => input.createdForThis.has(x.Id) || (!!notes && (x.Notes__c ?? null) === notes));
  const oursFree = ours.filter(free);
  if (oursFree.length === 1) {
    return { kind: "recover", sf: oursFree[0], why: `the write-back already created ${oursFree[0].Name} for this change order; its link here had been lost` };
  }
  if (ours.length > 1 || (ours.length === 1 && oursFree.length === 0)) {
    return {
      kind: "hold",
      why:
        ours.length > 1
          ? `${ours.length} Salesforce change orders (${ours.map((x) => x.Name).join(", ")}) look like the ones the write-back made for this — a person says which is it`
          : `${ours[0].Name} looks like the record the write-back made for this change order, but it is linked to another one here — a person looks`,
    };
  }

  // 2/3/4 ── an existing record at this amount ───────────────────────────────
  const allSameAmount = sfCos.filter((x) => cents(x.CostChange__c) === amount);
  const takenAlready = allSameAmount.filter((x) => !free(x));
  const sameAmount = allSameAmount.filter(free);
  const denied = sameAmount.filter((x) => !salesforceCounts(x.Status__c));
  if (local.shouldCount && denied.length > 0 && sameAmount.length === denied.length) {
    return {
      kind: "hold",
      why:
        `Salesforce has a change order on this job at ${usd(amount)} that its own org has ` +
        `${denied[0].Status__c} (${denied[0].Name}). Turning that back on is not a decision this can make.`,
    };
  }
  if (!input.personSaysItIsNew && sameAmount.length === 0 && takenAlready.length > 0) {
    return {
      kind: "hold",
      why:
        `Salesforce has ${takenAlready.length} change order(s) on this job at ${usd(amount)}, ` +
        `and every one is already linked to a different change order here. This may be a genuine second one at the same ` +
        `amount — a person confirms before a second record is created.`,
    };
  }
  if (!input.personSaysItIsNew && sameAmount.length > 1) {
    return {
      kind: "hold",
      why: `${sameAmount.length} Salesforce change orders on this job are already at ${usd(amount)} — a person has to say which, if any, is this one`,
    };
  }
  if (!input.personSaysItIsNew && sameAmount.length === 1) {
    return { kind: "adopt", sf: sameAmount[0], why: `already in Salesforce as ${sameAmount[0].Name}` };
  }

  // 5 ── reversed here, never there ─────────────────────────────────────────
  if (!local.shouldCount) return { kind: "nothing", why: "declined or deleted here, and Salesforce never had it" };

  // 6 ── Salesforce money nobody here stands for ────────────────────────────
  if (!input.personSaysItIsNew) {
    const unclaimed = sfCos.filter((x) => !claimedBy.has(x.Id) && salesforceCounts(x.Status__c));
    const unclaimedCents = unclaimed.reduce((n, x) => n + (cents(x.CostChange__c) ?? 0), 0);
    if (unclaimedCents > Math.round(input.liveRollupCents)) {
      return {
        kind: "hold",
        why:
          `Salesforce already holds ${usd(unclaimedCents)} of approved change orders on this job ` +
          `(${unclaimed.map((x) => `${x.Name} ${usd(cents(x.CostChange__c) ?? 0)}`).join(", ")}) that no change order here stands for` +
          `${input.liveRollupCents > 0 ? ` beyond the ${usd(Math.round(input.liveRollupCents))} migrated rollup` : ""}. ` +
          `Is this change order additional to them, or the same work itemised? If additional, a person confirms and it is added; ` +
          `if it is the same work, the Salesforce one has to be denied there instead — otherwise the job is counted twice.`,
      };
    }
  }

  // 7 ──────────────────────────────────────────────────────────────────────
  return { kind: "create", why: "new — nothing in Salesforce matches it" };
}

/** Throw on a refused read: a dropped error reads as "no rows", and "no rows" here means "create". */
function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T | null {
  if (r.error) throw new Error(`could not read ${what} (${r.error.message}) — nothing written`);
  return r.data;
}

/** Read one change order, the way this module needs it. */
export async function loadLocalChangeOrder(id: string): Promise<LocalChangeOrder | null> {
  const sb = admin();
  const { data, error } = await sb
    .from("commercial_change_orders")
    .select("id, opportunity_id, co_number, title, description, amount_cents, status, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`change order ${id}: ${error.message}`);
  if (!data) return null;
  const row = data as {
    id: string;
    opportunity_id: string;
    co_number: number | null;
    title: string | null;
    description: string | null;
    amount_cents: number;
    status: string;
    deleted_at: string | null;
  };
  const { data: deal, error: dealErr } = await sb
    .from("commercial_opportunities")
    .select("title, deleted_at")
    .eq("id", row.opportunity_id)
    .maybeSingle();
  if (dealErr) throw new Error(`change order ${id}'s deal: ${dealErr.message}`);
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    coNumber: row.co_number,
    title: row.title,
    description: row.description,
    amountCents: Number(row.amount_cents ?? 0),
    // A deleted change order counts for nothing, exactly like a declined one.
    // Both reach here through the same queue entry and the same reversal.
    shouldCount: !row.deleted_at && row.status === "approved",
    dealTitle: String((deal as { title?: string } | null)?.title ?? "a deal"),
    dealDeleted: !deal || !!(deal as { deleted_at?: string | null }).deleted_at,
  };
}

/**
 * Put one change order where it belongs in Salesforce.
 *
 * Returns rather than throws: the caller is a cron tick draining a queue, and
 * one change order that cannot be written must not stop the others. `held` is
 * not a failure — it means a person has to look, and the queue keeps it waiting
 * without burning the retry budget.
 */
export async function syncChangeOrder(ctx: Ctx, changeOrderId: string): Promise<ChangeOrderSyncOutcome> {
  const local = await loadLocalChangeOrder(changeOrderId);
  const out: ChangeOrderSyncOutcome = {
    changeOrderId,
    label: "a change order",
    action: "nothing",
    why: "",
    sfId: null,
    steps: [],
    checks: [],
  };
  if (!local) return { ...out, action: "nothing", why: "this change order no longer exists here" };

  out.label = `${local.dealTitle.slice(0, 40)} CO-${local.coNumber ?? "?"}`;

  /*
   * The synthetic rollup rows, never pushed. See ROLLUP_TITLE — one of them
   * stands for seven Salesforce records.
   */
  if (ROLLUP_TITLE.test(String(local.title ?? ""))) {
    return { ...out, action: "nothing", why: "a migrated rollup row, not a real change order — Salesforce already holds this money" };
  }

  const sb = admin();

  // Is it already linked to a Salesforce record? A failed read THROWS (F23 c):
  // read as "not linked", it sends a pushed change order down the create path.
  const linkRow = must(
    await sb.from("commercial_import_map").select("sf_id").eq("entity", CO_MAP_ENTITY).eq("row_id", local.id).maybeSingle(),
    "this change order's Salesforce link",
  );
  const linkedSfId = (linkRow as { sf_id?: string } | null)?.sf_id ?? null;

  /*
   * 🔴 THE DEAL WAS DELETED HERE (F24). Whatever Salesforce holds for this
   * change order stays exactly as it is until a person decides — the sync
   * never denies, edits or creates change orders for a job that has gone.
   * Before this, a deleted deal's linked change orders were re-asserted as
   * Approved by any sweep that touched them.
   */
  if (local.dealDeleted) {
    if (!linkedSfId) return { ...out, action: "nothing", why: "the deal was deleted here, and Salesforce never had this change order" };
    return {
      ...out,
      action: "held",
      waitsFor: "person",
      sfId: linkedSfId,
      why: `The deal was deleted here, but Salesforce still holds this change order (${linkedSfId}). Nothing is written — somebody decides what happens to it there.`,
    };
  }

  const desired = desiredSalesforceStatus(local);

  if (linkedSfId) {
    const r = await ctx.conn.query(
      `SELECT Id, Name, CostChange__c, Status__c, WorkOrder__c FROM ChangeOrder__c WHERE Id = '${assertSalesforceId(linkedSfId, "linked change order id")}'`,
    );
    const sf = r.records?.[0] as
      | { Id: string; Name: string; CostChange__c: number | null; Status__c: string | null }
      | undefined;
    if (!sf) {
      /*
       * Linked to a record Salesforce no longer returns. It cannot have been
       * deleted — the object is not deletable — so this is a record the
       * integration user has lost sight of, and guessing would mean creating a
       * second copy of real money. A person looks.
       */
      return {
        ...out,
        action: "held",
        waitsFor: "person",
        sfId: linkedSfId,
        why: `linked to Salesforce record ${linkedSfId}, which this user can no longer read`,
      };
    }
    out.sfId = sf.Id;
    if (!changeOrderNeedsWrite({ status: sf.Status__c, costChange: sf.CostChange__c }, local)) {
      /*
       * Nothing to write — but we have just READ the state, so assert it.
       * Returning no checks would mean `verified` is false and a previously
       * failed verification could never be cleared: "nothing to do" is exactly
       * the state a correctly written change order settles into for ever. See
       * the same reasoning in `updateExisting`'s Closed Won skip.
       */
      return {
        ...out,
        action: "nothing",
        why: `Salesforce already has it as ${sf.Status__c}`,
        sfId: sf.Id,
        checks: [
          {
            name: local.shouldCount ? "Salesforce counts it" : "Salesforce no longer counts it",
            ok: salesforceCounts(sf.Status__c) === local.shouldCount,
            detail: `status ${sf.Status__c ?? "unset"}`,
          },
          {
            name: "amount matches",
            ok: !local.shouldCount || cents(sf.CostChange__c) === Math.round(local.amountCents),
            detail: `${dollars(cents(sf.CostChange__c)).toFixed(2)} vs ${dollars(local.amountCents).toFixed(2)}`,
          },
        ],
      };
    }
    if (!ctx.apply) {
      return { ...out, action: "updated", sfId: sf.Id, why: `${sf.Status__c ?? "unset"} → ${desired}` };
    }
    const fields: Record<string, string | number | boolean | null> = { Status__c: desired };
    // Only worth sending on the way IN. The rollup ignores a denied record's
    // amount, so a reversal is one field.
    if (local.shouldCount) fields.CostChange__c = dollars(local.amountCents);
    const res = await writeSf(
      { sObject: "ChangeOrder__c", recordId: sf.Id, fields },
      {
        source: "tomco_writeback",
        triggeredByUserId: ctx.actorUserId,
        priorValues: { Status__c: sf.Status__c, CostChange__c: sf.CostChange__c },
      },
    );
    if (!res.ok) return { ...out, action: "failed", sfId: sf.Id, why: `${sf.Status__c ?? "unset"} → ${desired}`, error: res.error };
    out.steps.push(`${sf.Name}: ${sf.Status__c ?? "unset"} → ${desired}`);
    return { ...out, action: "updated", sfId: sf.Id, why: `${sf.Status__c ?? "unset"} → ${desired}`, checks: await readBack(ctx, sf.Id, local) };
  }

  /*
   * NOT LINKED. Which does NOT mean Salesforce has not got it.
   *
   * Measured on 2026-10-15: all five hand-typed approved change orders in the
   * Command Center were already in Salesforce, none of them linked — Mary and
   * Stephanie entered them in both systems during the dual run. An earlier
   * draft of the plan said "unmapped means new"; acting on that would have
   * doubled every one of them. So the test is what Salesforce actually holds.
   */
  const dealLink = must(
    await sb.from("commercial_import_map").select("sf_id").eq("entity", "deal").eq("row_id", local.opportunityId).maybeSingle(),
    "the deal's Salesforce link",
  );
  const sfOppId = (dealLink as { sf_id?: string } | null)?.sf_id ?? null;
  if (!sfOppId) {
    /*
     * The sale has not reached Salesforce yet. HELD on the EVENT clock: the
     * tick that writes the sale nudges this entry the moment it lands, so a
     * change order approved on a brand-new deal follows it within the minute.
     */
    return { ...out, action: "held", waitsFor: "event", why: "the deal is not in Salesforce yet — this will follow it in" };
  }

  const wos = await ctx.conn.query(
    `SELECT Id, WorkOrderNumber FROM WorkOrder WHERE Opportunity__c = '${assertSalesforceId(sfOppId, "opportunity id")}' AND Status != 'Canceled'`,
  );
  if (!wos.records.length) {
    /*
     * `ChangeOrder__c.WorkOrder__c` is required AND create-only, and this user
     * cannot create a Tomco WorkOrder. The org makes one from a synced quote,
     * with a lag — an event to wait for, for a day at most.
     */
    return { ...out, action: "held", waitsFor: "event", why: "no live work order in Salesforce to attach it to" };
  }
  const woList = wos.records as Array<{ Id: string; WorkOrderNumber: string }>;
  const woIds = woList.map((w) => assertSalesforceId(w.Id, "work order id"));
  const existing = await ctx.conn.query(
    `SELECT Id, Name, CostChange__c, Status__c, Notes__c FROM ChangeOrder__c WHERE WorkOrder__c IN ('${woIds.join("','")}')`,
  );
  const sfCos = (existing.records ?? []) as SfChangeOrderRow[];

  /*
   * WHO ALREADY OWNS THESE RECORDS HERE — read for these ids only.
   *
   * 🔴 F23 c. This read the WHOLE change-order entity of the import map, with
   * no paging (PostgREST stops at 1,000 rows without a word) and `error`
   * dropped — so a failed or truncated read made every record look unclaimed,
   * and the anti-steal guard it feeds was off exactly when it was needed.
   * Scoped to the records on this job, the read is a few rows and cannot be
   * truncated; and it throws.
   */
  const claimedBy = new Map<string, string>();
  if (sfCos.length > 0) {
    const rows =
      must(
        await sb.from("commercial_import_map").select("sf_id, row_id").eq("entity", CO_MAP_ENTITY).in("sf_id", sfCos.map((x) => x.Id)),
        "the change-order links on this job",
      ) ?? [];
    for (const r of rows as Array<{ sf_id: string; row_id: string }>) claimedBy.set(r.sf_id, r.row_id);
  }

  /*
   * THIS CHANGE ORDER'S OWN HISTORY: every Salesforce id the write-back
   * recorded against it — in an outcome ("created a09… on 00268849"), an
   * error, or a failed read-back. If the link row is lost, this is how the
   * record it made is found again instead of a second being created.
   */
  const createdForThis = new Set<string>();
  if (sfCos.length > 0) {
    const hist =
      must(
        await sb
          .from("commercial_tomco_writeback_queue")
          .select("outcome, last_error, verify_failed_reason")
          .eq("change_order_id", local.id)
          .limit(500),
        "this change order's write-back history",
      ) ?? [];
    const onThisJob = new Set(sfCos.map((x) => x.Id));
    for (const h of hist as Array<{ outcome: string | null; last_error: string | null; verify_failed_reason: string | null }>) {
      for (const t of `${h.outcome ?? ""} ${h.last_error ?? ""} ${h.verify_failed_reason ?? ""}`.match(/\b[a-zA-Z0-9]{15,18}\b/g) ?? []) {
        if (onThisJob.has(t)) createdForThis.add(t);
      }
    }
  }

  /*
   * Has a person already said "yes, it is a genuine second one"? Then the
   * amount and unclaimed-money holds are lifted — never the recovery above.
   */
  const forced = must(
    await sb.from("commercial_import_map").select("row_id").eq("entity", CO_FORCE_NEW_ENTITY).eq("row_id", local.id).maybeSingle(),
    "a person's second-change-order decision",
  );

  const siblings =
    must(
      await sb.from("commercial_change_orders").select("amount_cents, title, status, deleted_at").eq("opportunity_id", local.opportunityId),
      "this deal's change orders",
    ) ?? [];
  const liveRollupCents = (siblings as Array<{ amount_cents: number; title: string | null; status: string; deleted_at: string | null }>)
    .filter((r) => !r.deleted_at && r.status === "approved" && ROLLUP_TITLE.test(String(r.title ?? "").trim()))
    .reduce((n, r) => n + Number(r.amount_cents ?? 0), 0);

  const plan = planUnlinkedChangeOrder({
    local: { id: local.id, amountCents: local.amountCents, shouldCount: local.shouldCount, title: local.title, description: local.description },
    sfCos,
    claimedBy,
    createdForThis,
    personSaysItIsNew: !!forced,
    liveRollupCents,
  });

  if (plan.kind === "hold") return { ...out, action: "held", waitsFor: "person", why: plan.why };
  if (plan.kind === "nothing") return { ...out, action: "nothing", why: plan.why };

  if (plan.kind === "recover" || plan.kind === "adopt") {
    // Salesforce already has it. Link the two, then let the LINKED path make
    // the status and the amount agree — one place decides that, not two.
    const sf = plan.sf;
    out.sfId = sf.Id;
    if (!ctx.apply) {
      return { ...out, action: "adopted", sfId: sf.Id, why: `${plan.why} — would link, not create` };
    }
    const linked = await linkChangeOrder(
      local.id,
      sf.Id,
      plan.kind === "recover" ? "recovered: the write-back's own record, re-linked after the link was lost" : "adopted: already in Salesforce when the write-back found it",
    );
    if (!linked.ok) return { ...out, action: "failed", sfId: sf.Id, why: plan.kind, error: linked.error };
    const again = await syncChangeOrder(ctx, changeOrderId);
    return {
      ...again,
      action: again.action === "nothing" ? "adopted" : again.action,
      why: `${plan.why}; ${again.why}`,
      steps: [`linked to ${sf.Name}`, ...again.steps],
    };
  }

  // ── genuinely new ────────────────────────────────────────────────────────
  if (!ctx.apply) {
    return { ...out, action: "created", why: `would create on ${woList[0].WorkOrderNumber}` };
  }
  const fields = {
    WorkOrder__c: woIds[0],
    CostChange__c: dollars(local.amountCents),
    Status__c: APPROVED_STATUS,
    ReasonForChange__c: CHANGE_ORDER_REASON,
    Notes__c: changeOrderNotes(local),
  };
  /*
   * Made ONCE — not through `writeSf`, whose transport retry would repeat a
   * create that may already have landed — and recorded in `sf_writes_audit`,
   * which never saw a single one of these before (F38).
   */
  const t0 = Date.now();
  let res: { success?: boolean; id?: string; errors?: unknown };
  try {
    res = (await ctx.conn.sobject("ChangeOrder__c").create(fields)) as typeof res;
  } catch (e) {
    res = { success: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  await logSfCreate({
    sObject: "ChangeOrder__c",
    recordId: res.success && res.id ? res.id : null,
    fields,
    source: "tomco_writeback",
    triggeredByUserId: ctx.actorUserId,
    succeeded: !!(res.success && res.id),
    error: res.success ? null : JSON.stringify(res.errors ?? res),
    durationMs: Date.now() - t0,
  });
  if (!res.success || !res.id) {
    return { ...out, action: "failed", why: "create", error: JSON.stringify(res.errors ?? res) };
  }
  out.sfId = res.id;
  out.steps.push(`created ${res.id} on ${woList[0].WorkOrderNumber}`);

  /*
   * 🔴 THE LINK, OR THE NEXT IMPORT DOUBLE-COUNTS IT.
   *
   * Salesforce's `TotalChangeOrder__c` on that work order just went up by this
   * amount, and the importer subtracts linked rows from the per-job total it
   * carries — this link is what lets it. If the link fails, the error names the
   * record, so this entry's own history can find it again (rule 1 above).
   */
  const linked = await linkChangeOrder(local.id, res.id, "created by the Tomco write-back");
  if (!linked.ok) {
    return {
      ...out,
      action: "failed",
      why: "created, but the link did not save",
      error:
        `Salesforce has the change order (${res.id}) but the link did not save here (${linked.error}). ` +
        `The retry finds ${res.id} in this entry's history and re-links it rather than creating a second.`,
    };
  }
  out.steps.push("linked in the import map");

  /*
   * 🔴 AND THE "IT IS A SECOND ONE" MARKER IS SPENT (F23 d).
   *
   * It was never cleared, so it outlived the create it authorised: a later lost
   * link skipped every hold and created the change order again, up to three
   * times. A person's answer was about ONE record.
   */
  if (forced) {
    const { error: clearErr } = await sb
      .from("commercial_import_map")
      .delete()
      .eq("entity", CO_FORCE_NEW_ENTITY)
      .eq("row_id", local.id);
    out.steps.push(clearErr ? `⚠ the second-change-order marker could not be cleared (${clearErr.message})` : "second-change-order marker spent");
  }
  return {
    ...out,
    action: "created",
    why: `created ${res.id} on ${woList[0].WorkOrderNumber}`,
    checks: await readBack(ctx, res.id, local),
  };
}

/**
 * "Yes, it is a genuine second change order at this amount — create it."
 *
 * The one action that releases the hold described on `CO_FORCE_NEW_ENTITY`.
 * Recorded rather than applied immediately, so the decision survives and the
 * next tick does the writing through the normal path.
 */
export async function allowSecondChangeOrder(
  changeOrderId: string,
  actorUserId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const sb = admin();
  const { error } = await sb.from("commercial_import_map").upsert(
    {
      sf_id: coForceNewMarker(changeOrderId),
      entity: CO_FORCE_NEW_ENTITY,
      row_id: changeOrderId,
      notes: `a person confirmed this is a second change order at the same amount, not a duplicate${actorUserId ? ` (${actorUserId})` : ""}`,
      updated_at: new Date(0).toISOString(),
    },
    { onConflict: "sf_id,entity" },
  );
  if (error) return { ok: false, error: error.message };
  // Let the next tick act on it rather than waiting out the back-off.
  const { releaseHoldForChangeOrder } = await import("@/lib/salesforce/tomco-queue");
  await releaseHoldForChangeOrder(changeOrderId);
  return { ok: true };
}

/** Record which Salesforce change order a Command Center one is. */
async function linkChangeOrder(rowId: string, sfId: string, notes: string): Promise<{ ok: boolean; error?: string }> {
  const sb = admin();
  const { error } = await sb.from("commercial_import_map").upsert(
    {
      sf_id: sfId,
      entity: CO_MAP_ENTITY,
      row_id: rowId,
      notes,
      /*
       * Epoch-stamped, like every other row this feature writes. It makes
       * `editedHere()` read the Command Center row as human-edited, so the
       * importer never stamps Salesforce's version over the real one.
       */
      updated_at: new Date(0).toISOString(),
    },
    { onConflict: "sf_id,entity" },
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Read it back. The rollups are asynchronous, so this waits — a check that runs
 * too early reports a failure that is not one, which is worse than no check.
 */
async function readBack(ctx: Ctx, sfId: string, local: LocalChangeOrder): Promise<ChangeOrderSyncOutcome["checks"]> {
  await new Promise((r) => setTimeout(r, 6000));
  const r = await ctx.conn.query(
    `SELECT Id, Status__c, CostChange__c, WorkOrder__c, WorkOrder__r.TotalChangeOrder__c FROM ChangeOrder__c WHERE Id = '${assertSalesforceId(sfId, "change order id")}'`,
  );
  const sf = r.records?.[0] as
    | {
        Status__c: string | null;
        CostChange__c: number | null;
        WorkOrder__c: string | null;
        WorkOrder__r?: { TotalChangeOrder__c: number | null };
      }
    | undefined;
  /*
   * 🔴 THE RECORD CAME BACK AT ALL.
   *
   * Without this, a reversal whose record could not be read reported VERIFIED:
   * `sf` was undefined, `salesforceCounts(undefined)` is false, `shouldCount`
   * is false, so `false === false` passed with the detail "status unknown". The
   * check that was supposed to prove the money came back out instead proved
   * nothing and said it had.
   */
  const checks: ChangeOrderSyncOutcome["checks"] = [
    { name: "Salesforce returned the record", ok: !!sf, detail: sf ? sfId : `could not read ${sfId} back` },
  ];
  if (!sf) return checks;

  const counts = salesforceCounts(sf.Status__c);
  checks.push({
    name: local.shouldCount ? "Salesforce counts it" : "Salesforce no longer counts it",
    ok: counts === local.shouldCount,
    detail: `status ${sf.Status__c ?? "unset"}`,
  });
  if (local.shouldCount) {
    checks.push({
      name: "amount matches",
      ok: cents(sf.CostChange__c) === Math.round(local.amountCents),
      detail: `${dollars(cents(sf.CostChange__c)).toFixed(2)} vs ${dollars(local.amountCents).toFixed(2)}`,
    });
  }
  /*
   * THE ROLLUP CHECK WAS DECORATIVE, AND IT ALSO FIRED FALSELY.
   *
   * It was `total !== 0 || !shouldCount`. On a reversal the right-hand side is
   * always true, so the check named "the work-order rollup moved" could not
   * fail on the one path where it matters — it never verified the money came
   * back out. On an approval it only asserted the total was non-zero, which
   * passes on any job that already had another approved change order, so it
   * could not detect THIS amount failing to land.
   *
   * And it failed on a legitimate state: a +$500 change order and a -$500
   * deduct are both allowed, and together they leave the rollup at exactly $0 —
   * a correct total that the old check called a failure, burning an attempt.
   *
   * So the honest assertion is the one that is actually checkable: the rollup
   * equals the sum of the approved change orders Salesforce holds on that work
   * order. If this record's money is in, that sum includes it; if a reversal
   * worked, it does not.
   */
  const woId = sf.WorkOrder__c;
  if (!woId) {
    checks.push({ name: "the record is attached to a work order", ok: false, detail: "WorkOrder__c is empty" });
    return checks;
  }
  const siblings = await ctx.conn.query(
    `SELECT Id, CostChange__c, Status__c FROM ChangeOrder__c WHERE WorkOrder__c = '${assertSalesforceId(woId, "work order id")}'`,
  );
  const approvedSum = (siblings.records as Array<{ Id: string; CostChange__c: number | null; Status__c: string | null }>)
    .filter((c) => salesforceCounts(c.Status__c))
    .reduce((n, c) => n + cents(c.CostChange__c), 0);
  const rollup = cents(sf.WorkOrder__r?.TotalChangeOrder__c);
  checks.push({
    name: "the work-order rollup equals its approved change orders",
    ok: rollup === approvedSum,
    detail: `rollup ${dollars(rollup).toFixed(2)} vs approved ${dollars(approvedSum).toFixed(2)}`,
  });
  // And this record's own money is on the right side of that sum.
  const included = (siblings.records as Array<{ Id: string; Status__c: string | null }>)
    .some((c) => c.Id === sfId && salesforceCounts(c.Status__c));
  checks.push({
    name: local.shouldCount ? "this change order is inside the rollup" : "this change order is outside the rollup",
    ok: included === local.shouldCount,
    detail: included ? "counted" : "not counted",
  });
  return checks;
}
