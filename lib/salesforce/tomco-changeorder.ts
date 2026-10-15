import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

import { getSalesforceClient } from "@/lib/salesforce/client";
import { writeSf } from "@/lib/salesforce/writeback";

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
  const { data: deal } = await sb
    .from("commercial_opportunities")
    .select("title")
    .eq("id", row.opportunity_id)
    .maybeSingle();
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

  // Is it already linked to a Salesforce record?
  const { data: linkRow } = await sb
    .from("commercial_import_map")
    .select("sf_id")
    .eq("entity", CO_MAP_ENTITY)
    .eq("row_id", local.id)
    .maybeSingle();
  const linkedSfId = (linkRow as { sf_id?: string } | null)?.sf_id ?? null;

  const desired = desiredSalesforceStatus(local);

  if (linkedSfId) {
    const r = await ctx.conn.query(
      `SELECT Id, Name, CostChange__c, Status__c, WorkOrder__c FROM ChangeOrder__c WHERE Id = '${linkedSfId}'`,
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
        sfId: linkedSfId,
        why: `linked to Salesforce record ${linkedSfId}, which this user can no longer read`,
      };
    }
    out.sfId = sf.Id;
    if (!changeOrderNeedsWrite({ status: sf.Status__c, costChange: sf.CostChange__c }, local)) {
      return { ...out, action: "nothing", why: `Salesforce already has it as ${sf.Status__c}`, sfId: sf.Id };
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
  const { data: dealLink } = await sb
    .from("commercial_import_map")
    .select("sf_id")
    .eq("entity", "deal")
    .eq("row_id", local.opportunityId)
    .maybeSingle();
  const sfOppId = (dealLink as { sf_id?: string } | null)?.sf_id ?? null;
  if (!sfOppId) {
    /*
     * The sale has not reached Salesforce yet. HELD, not failed: `markHeld`
     * does not count an attempt, so this entry waits in the queue and the
     * tick that follows the sale's own write-back picks it up. That is the
     * self-healing order — a change order approved on a brand-new deal lands
     * a minute after the deal does.
     */
    return { ...out, action: "held", why: "the deal is not in Salesforce yet — this will follow it in" };
  }

  const wos = await ctx.conn.query(
    `SELECT Id, WorkOrderNumber FROM WorkOrder WHERE Opportunity__c = '${sfOppId}' AND Status != 'Canceled'`,
  );
  if (!wos.records.length) {
    /*
     * `ChangeOrder__c.WorkOrder__c` is required AND create-only, and this user
     * cannot create a Tomco WorkOrder — its record type reads available=false.
     * So there is nowhere to put it, and no amount of retrying changes that.
     */
    return { ...out, action: "held", why: "no live work order in Salesforce to attach it to" };
  }
  const woIds = (wos.records as Array<{ Id: string; WorkOrderNumber: string }>).map((w) => w.Id);
  const existing = await ctx.conn.query(
    `SELECT Id, Name, CostChange__c, Status__c FROM ChangeOrder__c WHERE WorkOrder__c IN ('${woIds.join("','")}')`,
  );
  const sameAmount = (existing.records as Array<{ Id: string; Name: string; CostChange__c: number | null; Status__c: string | null }>)
    .filter((x) => cents(x.CostChange__c) === Math.round(local.amountCents));

  if (sameAmount.length > 1) {
    /*
     * No key can tell "entered twice" from "two genuine change orders for the
     * same amount", and that case is live in this data. A person decides.
     */
    return {
      ...out,
      action: "held",
      why: `${sameAmount.length} Salesforce change orders on this job are already at ${dollars(local.amountCents).toFixed(2)} — a person has to say which, if any, is this one`,
    };
  }

  if (sameAmount.length === 1) {
    // ADOPT: Salesforce already has it. Link the two, then make the status agree.
    const sf = sameAmount[0];
    out.sfId = sf.Id;
    if (!ctx.apply) {
      return { ...out, action: "adopted", sfId: sf.Id, why: `already in Salesforce as ${sf.Name} (${sf.Status__c}) — would link, not create` };
    }
    const linked = await linkChangeOrder(local.id, sf.Id, "adopted: already in Salesforce when the write-back found it");
    if (!linked.ok) return { ...out, action: "failed", sfId: sf.Id, why: "adopt", error: linked.error };
    out.steps.push(`linked to ${sf.Name}`);
    if (changeOrderNeedsWrite({ status: sf.Status__c, costChange: sf.CostChange__c }, local)) {
      const res = await writeSf(
        { sObject: "ChangeOrder__c", recordId: sf.Id, fields: { Status__c: desired } },
        { source: "tomco_writeback", triggeredByUserId: ctx.actorUserId, priorValues: { Status__c: sf.Status__c } },
      );
      if (!res.ok) return { ...out, action: "failed", sfId: sf.Id, why: "adopted, then could not set the status", error: res.error };
      out.steps.push(`${sf.Status__c ?? "unset"} → ${desired}`);
    }
    return { ...out, action: "adopted", sfId: sf.Id, why: `already in Salesforce as ${sf.Name}`, checks: await readBack(ctx, sf.Id, local) };
  }

  /*
   * Genuinely new. And if it is already reversed here, there is nothing to
   * create — creating a Denied record would only put a row in Katie's org that
   * means nothing to anybody.
   */
  if (!local.shouldCount) {
    return { ...out, action: "nothing", why: "declined or deleted here, and Salesforce never had it" };
  }
  if (!ctx.apply) {
    return { ...out, action: "created", why: `would create on ${wos.records[0].WorkOrderNumber}` };
  }
  const res = await ctx.conn.sobject("ChangeOrder__c").create({
    WorkOrder__c: woIds[0],
    CostChange__c: dollars(local.amountCents),
    Status__c: APPROVED_STATUS,
    ReasonForChange__c: CHANGE_ORDER_REASON,
    Notes__c: [local.title, local.description].filter(Boolean).join(" — ").slice(0, 2000) || null,
  });
  if (!res.success) {
    return { ...out, action: "failed", why: "create", error: JSON.stringify((res as { errors?: unknown }).errors ?? res) };
  }
  out.sfId = res.id;
  out.steps.push(`created ${res.id} on ${wos.records[0].WorkOrderNumber}`);

  /*
   * 🔴 THE LINK, OR THE NEXT IMPORT DOUBLE-COUNTS IT.
   *
   * Salesforce's `TotalChangeOrder__c` on that work order just went up by this
   * amount, and `stageChangeOrders` carries that total into the migrated
   * CO-001 row. Without this link the importer cannot tell which part of the
   * total it already holds as a real change order, so it would fold this money
   * in a second time. Green Leaf was in exactly that state on 2026-10-15 —
   * $18,800 in Salesforce against an $18,250 rollup row and a $550 change
   * order. The importer subtracts linked rows; this is what makes it able to.
   */
  const linked = await linkChangeOrder(local.id, res.id, "created by the Tomco write-back");
  if (!linked.ok) {
    return {
      ...out,
      action: "failed",
      why: "created, but the link did not save",
      error:
        `Salesforce has the change order (${res.id}) but the link did not save here (${linked.error}). ` +
        `FIX THIS BEFORE THE NEXT IMPORT — without it, tonight's run counts this money twice.`,
    };
  }
  out.steps.push("linked in the import map");
  return { ...out, action: "created", why: `created on ${wos.records[0].WorkOrderNumber}`, checks: await readBack(ctx, res.id, local) };
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
    `SELECT Id, Status__c, CostChange__c, WorkOrder__r.TotalChangeOrder__c FROM ChangeOrder__c WHERE Id = '${sfId}'`,
  );
  const sf = r.records?.[0] as
    | { Status__c: string | null; CostChange__c: number | null; WorkOrder__r?: { TotalChangeOrder__c: number | null } }
    | undefined;
  const counts = salesforceCounts(sf?.Status__c);
  const checks: ChangeOrderSyncOutcome["checks"] = [
    {
      name: local.shouldCount ? "Salesforce counts it" : "Salesforce no longer counts it",
      ok: counts === local.shouldCount,
      detail: `status ${sf?.Status__c ?? "unknown"}`,
    },
  ];
  if (local.shouldCount) {
    checks.push({
      name: "amount matches",
      ok: cents(sf?.CostChange__c) === Math.round(local.amountCents),
      detail: `${dollars(cents(sf?.CostChange__c)).toFixed(2)} vs ${dollars(local.amountCents).toFixed(2)}`,
    });
  }
  checks.push({
    name: "the work-order rollup moved",
    ok: Number(sf?.WorkOrder__r?.TotalChangeOrder__c ?? 0) !== 0 || !local.shouldCount,
    detail: `TotalChangeOrder__c ${Number(sf?.WorkOrder__r?.TotalChangeOrder__c ?? 0).toFixed(2)}`,
  });
  return checks;
}
