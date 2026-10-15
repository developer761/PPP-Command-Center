import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";
import { writeSf } from "@/lib/salesforce/writeback";
import type { SoldDeal } from "@/lib/salesforce/tomco-pairing";

/**
 * The write-back itself: a sold Command Center deal, put into Salesforce.
 *
 * Everything upstream of this decides WHETHER to write (tomco-decide.ts) and
 * WHICH record (tomco-pairing.ts). This does the writing, and its whole job is
 * to be dull and checkable.
 *
 * THE MONEY GOES ON THE QUOTE LINE, NOT THE OPPORTUNITY
 *
 * Proven on live records 2026-10-14, after being wrong about it three times:
 *
 *   QuoteLineItem.PriceOverride__c       = true          a boolean switch
 *   QuoteLineItem.PriceOverrideAmount__c = the contract  the ONLY money field
 *        └→ TotalPrice__c            formula
 *             └→ Quote.Subtotal__c        rollup
 *                  └→ Quote.QuotedSubtotal__c   formula
 *                       └→ Opportunity.Quote_Subtotal__c   set by a flow
 *
 * So we write one input and let the org compute the rest. Nothing we write can
 * then be clobbered by a flow, and `Opportunity.Quote_Subtotal__c` is a
 * READ-BACK CHECK rather than something to set — writing it would be undone.
 *
 * THE CONTRACT WE SEND EXCLUDES CHANGE ORDERS
 *
 * `accepted_contract_cents` is the base. Approved change orders go in
 * separately as ChangeOrder__c records, and Salesforce rolls them up into
 * `QuotedSubtotalWithChangeOrder__c` itself. Sending a CO-inclusive figure here
 * would have the org add them twice.
 */

/** Salesforce money is dollars; we keep cents. One place does the conversion. */
const dollars = (cents: number | null | undefined) => Math.round(Number(cents ?? 0)) / 100;

export type WriteBackOutcome = {
  dealId: string;
  dealTitle: string;
  action: "updated" | "created" | "skipped" | "failed";
  sfId: string | null;
  steps: string[];
  /** Everything that must be true afterwards, and whether it is. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  error?: string;
};

type Ctx = {
  conn: Awaited<ReturnType<typeof getSalesforceClient>>;
  actorUserId: string | null;
  apply: boolean;
};

async function soqlOne<T = Record<string, unknown>>(ctx: Ctx, q: string): Promise<T | null> {
  const r = await ctx.conn.query(q);
  return (r.records?.[0] as T) ?? null;
}

/**
 * Update a deal Salesforce already has.
 *
 * 🔴 `CloseDate` IS NEVER SENT HERE. `Close_Date_Uneditable_after_Closed_Won_L`
 * rejects any update that changes it without also changing the stage, so
 * sending it would make every subsequent run of this function fail forever on
 * that record. Katie settled the policy on 2026-10-14 — the date Salesforce
 * stamps on the way in is the one we keep — so there is nothing to send.
 */
export async function updateExisting(
  ctx: Ctx,
  deal: SoldDeal,
  sfId: string,
): Promise<WriteBackOutcome> {
  const out: WriteBackOutcome = {
    dealId: deal.id,
    dealTitle: deal.title,
    action: "updated",
    sfId,
    steps: [],
    checks: [],
  };
  const contract = dollars(deal.contractCents);

  const opp = await soqlOne<{
    Id: string;
    StageName: string;
    Corporate_Name__c: string | null;
    Quote_Subtotal__c: number | null;
    /*
     * The CANONICAL sales metric — `Opportunity.QuotedSubtotalWithChangeOrder__c`
     * (no underscores on the Opportunity; the WorkOrder spells the same concept
     * `Quoted_Subtotal_with_Change_Order__c`). Read only to describe a skip
     * honestly, never written: it is derived.
     */
    QuotedSubtotalWithChangeOrder__c: number | null;
    Pricebook2Id: string | null;
  }>(
    ctx,
    `SELECT Id, StageName, Corporate_Name__c, Quote_Subtotal__c, QuotedSubtotalWithChangeOrder__c, Pricebook2Id
       FROM Opportunity WHERE Id = '${sfId}'`,
  );
  if (!opp) {
    return { ...out, action: "failed", error: `Salesforce has no opportunity ${sfId}` };
  }
  if (opp.Corporate_Name__c !== "Tomco Painting") {
    /*
     * Refuse rather than proceed. Corporate_Name__c is what every Tomco query
     * in both systems filters on, so writing to a record carrying a different
     * one would push a Tomco sale into another company's book.
     */
    return {
      ...out,
      action: "failed",
      error: `${sfId} is "${opp.Corporate_Name__c ?? "unset"}", not Tomco Painting — refusing to write to it`,
    };
  }

  /*
   * 🔴 A DEAL SALESFORCE HAS ALREADY WON IS NOT OURS TO RESTATE.
   *
   * It came OUT of Salesforce and Salesforce still holds it correctly — §1 of
   * the plan, which measured that the old four-field backfill would have
   * deleted $192,594.77 of real sales. The first version of this function
   * ignored that: it skipped a deal only when the money ALREADY agreed, so it
   * would have rewritten the quote line on all 19 linked deals where the two
   * figures differ — and on five of those ours is LOWER, erasing $19,886.26.
   *
   *   Switching Power     ours  $2,300.00   Salesforce $15,700.00
   *   Sunday Maintenance  ours $13,863.74   Salesforce $17,250.00
   *   99 Bridge Road      ours $13,600.00   Salesforce $15,000.00
   *
   * Those gaps are Salesforce knowing something we do not — later billing, a
   * change order folded into the quote — and our base is not a correction to
   * it. So the money is written only when WE are the ones closing the sale.
   * Once it is Closed Won over there, this function reports and stops.
   */
  if (opp.StageName === "Closed Won") {
    /*
     * SAY WHICH FIGURE DISAGREES, because the quote line is not the one that
     * matters and a message naming only it sends people chasing nothing.
     *
     * Majestic Properties, on the first real tick: the quote line read $9,060
     * against our $9,852.76, so this said "our base is 9852.76, and the
     * difference is Salesforce's to keep" — reading as a $792.76 discrepancy on
     * a job that agrees to the cent. `QuotedSubtotalWithChangeOrder__c`, the
     * canonical sales metric and the number Katie's reports run on, is
     * $9,852.76 there. The $792.76 lives in the work order's own line items,
     * which no surface here claims to mirror.
     */
    const quoteLine = Number(opp.Quote_Subtotal__c ?? 0);
    const canonical = Number(opp.QuotedSubtotalWithChangeOrder__c ?? 0);
    const quoteLineAgrees = Math.abs(quoteLine - contract) < 0.005;
    const canonicalAgrees = Math.abs(canonical - contract) < 0.005;
    const note = quoteLineAgrees
      ? ""
      : canonicalAgrees
        ? `; its quote line reads ${quoteLine.toFixed(2)}, but the total Katie's reports use already matches us to the cent`
        : `; our base is ${contract.toFixed(2)} against their ${canonical.toFixed(2)} — the difference is Salesforce's to keep`;
    return {
      ...out,
      action: "skipped",
      steps: [`already Closed Won in Salesforce at ${canonical.toFixed(2)} — left alone${note}`],
    };
  }
  if (ctx.apply) {
    const res = await writeSf(
      { sObject: "Opportunity", recordId: sfId, fields: { StageName: "Closed Won" } },
      { source: "tomco_writeback", triggeredByUserId: ctx.actorUserId, deferCacheInvalidation: true, priorValues: { StageName: opp.StageName } },
    );
    if (!res.ok) return { ...out, action: "failed", error: `stage: ${res.error}` };
    out.steps.push(`stage ${opp.StageName} → Closed Won`);
  } else {
    out.steps.push(`would set stage ${opp.StageName} → Closed Won, and the line to ${contract.toFixed(2)}`);
  }

  // ── the quote, matched rather than created ───────────────────────────────
  const quotes = await ctx.conn.query(
    `SELECT Id, Status, Subtotal__c FROM Quote WHERE OpportunityId = '${sfId}'`,
  );
  const qs = (quotes.records ?? []) as Array<{ Id: string; Status: string; Subtotal__c: number | null }>;
  if (qs.length > 1) {
    /*
     * Which quote IS the sale is not ours to decide — approving the wrong one
     * puts the wrong number on the opportunity. 31 Tomco opportunities sit at
     * "Estimate Sent / Quote Sent" with exactly one quote; more than one is
     * rare and worth a person.
     */
    return { ...out, action: "failed", error: `${qs.length} quotes on ${sfId} — a person has to say which is the sale` };
  }

  let quoteId = qs[0]?.Id ?? null;
  if (!quoteId) {
    out.steps.push("no quote on this opportunity — creating one");
    if (ctx.apply) {
      const created = await ctx.conn.sobject("Quote").create({
        Name: deal.title.slice(0, 255),
        OpportunityId: sfId,
        ...(opp.Pricebook2Id ? { Pricebook2Id: opp.Pricebook2Id } : {}),
        Status: "Draft",
      });
      if (!created.success) return { ...out, action: "failed", error: `quote create failed` };
      quoteId = created.id;
    }
  }

  // ── the line, which is where the money lives ─────────────────────────────
  if (quoteId && ctx.apply) {
    const lines = await ctx.conn.query(
      `SELECT Id, PriceOverride__c, PriceOverrideAmount__c, TotalPrice__c FROM QuoteLineItem WHERE QuoteId = '${quoteId}'`,
    );
    const ls = (lines.records ?? []) as Array<{ Id: string; PriceOverrideAmount__c: number | null }>;
    if (ls.length > 1) {
      // Four Tomco quotes are genuinely itemised. Spreading one contract figure
      // across them, or collapsing them to one, both destroy the breakdown.
      return { ...out, action: "failed", error: `${ls.length} lines on quote ${quoteId} — itemised, a person decides` };
    }
    if (ls.length === 1) {
      if (Number(ls[0].PriceOverrideAmount__c ?? 0) === contract) {
        out.steps.push(`line already ${contract.toFixed(2)} — left alone`);
      } else {
        const res = await writeSf(
          { sObject: "QuoteLineItem", recordId: ls[0].Id, fields: { PriceOverride__c: true, PriceOverrideAmount__c: contract } },
          { source: "tomco_writeback", triggeredByUserId: ctx.actorUserId, deferCacheInvalidation: true, priorValues: { PriceOverrideAmount__c: ls[0].PriceOverrideAmount__c } },
        );
        if (!res.ok) return { ...out, action: "failed", error: `line: ${res.error}` };
        out.steps.push(`line ${ls[0].PriceOverrideAmount__c ?? "—"} → ${contract.toFixed(2)}`);
      }
    } else {
      out.steps.push("no line on the quote — see the insert path; not created on an update");
    }

    // Approve the quote, which is what closes the sale in Tomco's convention:
    // 82 of their won opportunities carry an Approved quote.
    const q = qs[0];
    if (q && q.Status !== "Approved") {
      const res = await writeSf(
        { sObject: "Quote", recordId: q.Id, fields: { Status: "Approved" } },
        { source: "tomco_writeback", triggeredByUserId: ctx.actorUserId, deferCacheInvalidation: true, priorValues: { Status: q.Status } },
      );
      if (!res.ok) return { ...out, action: "failed", error: `quote status: ${res.error}` };
      out.steps.push(`quote ${q.Status} → Approved`);
    }
  } else if (quoteId) {
    out.steps.push(`would set the quote line to ${contract.toFixed(2)} and approve the quote`);
  }

  // ── read back, because a write that reports success is not evidence ───────
  if (ctx.apply) {
    // Flows are asynchronous; give the rollup a moment to land.
    await new Promise((r) => setTimeout(r, 6000));
    const after = await soqlOne<{
      StageName: string;
      Corporate_Name__c: string | null;
      Quote_Subtotal__c: number | null;
      QuotedSubtotalWithChangeOrder__c: number | null;
    }>(
      ctx,
      `SELECT StageName, Corporate_Name__c, Quote_Subtotal__c, QuotedSubtotalWithChangeOrder__c
         FROM Opportunity WHERE Id = '${sfId}'`,
    );
    out.checks.push({
      name: "stage is Closed Won",
      ok: after?.StageName === "Closed Won",
      detail: after?.StageName ?? "unknown",
    });
    out.checks.push({
      name: "still Tomco Painting",
      ok: after?.Corporate_Name__c === "Tomco Painting",
      detail: after?.Corporate_Name__c ?? "unset",
    });
    out.checks.push({
      name: "contract value arrived",
      ok: Math.abs(Number(after?.Quote_Subtotal__c ?? 0) - contract) < 0.005,
      detail: `Quote_Subtotal__c = ${after?.Quote_Subtotal__c ?? "null"} (sent ${contract.toFixed(2)})`,
    });
  }
  return out;
}

/**
 * Create a sale Salesforce has never seen.
 *
 * The only action in this whole feature that can put a SECOND copy of a real
 * sale into the total Katie runs the company on, so it is the most guarded.
 *
 * THE IDEMPOTENCY GUARD IS A QUERY, NOT A FLAG.
 *
 * `writeSf` retries up to three times on anything outside its fatal-error
 * regex, and a timed-out create is a network error — so it retries the create.
 * Two records from one call, before any id exists to store. The defence is to
 * look the deal up by its external id immediately before inserting and again
 * if anything goes wrong: `UniqueExternalId__c` is unique in the org, so the
 * second insert of a pair is rejected by Salesforce itself rather than landing.
 */
export async function createNew(
  ctx: Ctx,
  deal: SoldDeal,
  opts: { accountId: string | null; closeDate: string },
): Promise<WriteBackOutcome> {
  const out: WriteBackOutcome = {
    dealId: deal.id,
    dealTitle: deal.title,
    action: "created",
    sfId: null,
    steps: [],
    checks: [],
  };
  const contract = dollars(deal.contractCents);

  // ── already there? ───────────────────────────────────────────────────────
  const already = await soqlOne<{ Id: string; Name: string }>(
    ctx,
    `SELECT Id, Name FROM Opportunity WHERE UniqueExternalId__c = '${deal.id}'`,
  );
  if (already) {
    return {
      ...out,
      action: "skipped",
      sfId: already.Id,
      steps: [`already in Salesforce as "${already.Name}" (${already.Id}) — nothing to create`],
    };
  }

  // ── resolve by name, never from a constant ───────────────────────────────
  // Every id differs between sandbox and production: the record type, the
  // pricebook, the "Other" entry and Brendan's user are all different ids.
  const rt = await soqlOne<{ Id: string }>(
    ctx,
    `SELECT Id FROM RecordType WHERE SobjectType = 'Opportunity' AND Name = 'Tomco' LIMIT 1`,
  );
  const book = await soqlOne<{ Id: string }>(
    ctx,
    `SELECT Id FROM Pricebook2 WHERE Name = 'Tomco' AND IsActive = true LIMIT 1`,
  );
  if (!rt || !book) {
    return { ...out, action: "failed", error: "could not resolve the Tomco record type or pricebook" };
  }
  const pbe = await soqlOne<{ Id: string; Product2Id: string; UnitPrice: number }>(
    ctx,
    `SELECT Id, Product2Id, UnitPrice FROM PricebookEntry
       WHERE Pricebook2Id = '${book.Id}' AND Product2.Name = 'Other' AND IsActive = true LIMIT 1`,
  );
  if (!pbe) {
    return { ...out, action: "failed", error: `no active "Other" entry in the Tomco pricebook` };
  }
  const owner = await soqlOne<{ Id: string }>(
    ctx,
    `SELECT Id FROM User WHERE Name = 'Brendan Tomco' AND IsActive = true LIMIT 1`,
  );

  if (!ctx.apply) {
    out.steps.push(
      `would create: Opportunity "${deal.title.slice(0, 120)}" · Closed Won · ${opts.closeDate} · ` +
        `${opts.accountId ? `account ${opts.accountId}` : "NO ACCOUNT"} · then a Quote and one line at ${contract.toFixed(2)}`,
    );
    return out;
  }

  // ── the opportunity ──────────────────────────────────────────────────────
  // CloseDate IS sent here, and only here. It is required on insert
  // (nillable=0, defaultedOnCreate=0) and rejected on update, which is exactly
  // why this cannot be one upsert call.
  const oppRes = await ctx.conn.sobject("Opportunity").create({
    Name: deal.title.slice(0, 120),
    StageName: "Closed Won",
    CloseDate: opts.closeDate,
    RecordTypeId: rt.Id,
    Pricebook2Id: book.Id,
    LeadSource: "Tomco",
    UniqueExternalId__c: deal.id,
    ...(opts.accountId ? { AccountId: opts.accountId } : {}),
    ...(owner ? { OwnerId: owner.Id } : {}),
  });
  if (!oppRes.success) {
    return { ...out, action: "failed", error: `opportunity: ${JSON.stringify(oppRes.errors ?? oppRes)}` };
  }
  out.sfId = oppRes.id;
  out.steps.push(`Opportunity ${oppRes.id}`);

  /*
   * 🔴 SET THE NAME AGAIN. A FLOW OVERWRITES IT ON INSERT.
   *
   * We sent "Flagstar Bank Trash Enclosures" and Salesforce stored
   * "PCCI Builders Corp. Opp - 2026-10-14" — something on this object renames
   * an opportunity to "{Account} Opp - {date}" on create. 36 of the 200 Tomco
   * records already carry that pattern, so it has been quietly costing them the
   * job name for a while.
   *
   * It matters because the name is what Katie reads in a report and what a
   * person matches on in the pairing queue; "PCCI Builders Corp. Opp" tells
   * nobody which job it was. Tested: the rename HOLDS on a later update, so the
   * fix is simply to say it twice.
   */
  const wanted = deal.title.slice(0, 120);
  const named = await soqlOne<{ Name: string }>(ctx, `SELECT Name FROM Opportunity WHERE Id = '${oppRes.id}'`);
  if (named && named.Name !== wanted) {
    try {
      await ctx.conn.sobject("Opportunity").update({ Id: oppRes.id, Name: wanted });
      out.steps.push(`name restored (a flow had set it to "${named.Name}")`);
    } catch (e) {
      // Not fatal — the sale and its money are right, only the label is wrong.
      out.steps.push(`⚠ could not restore the name: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── the quote and its one line ───────────────────────────────────────────
  const quoteRes = await ctx.conn.sobject("Quote").create({
    Name: deal.title.slice(0, 255),
    OpportunityId: oppRes.id,
    Pricebook2Id: book.Id,
    Status: "Draft",
  });
  if (!quoteRes.success) {
    // The sale exists and carries the external id, so a re-run finds it and
    // does not duplicate. Report loudly: the money is not there yet.
    return { ...out, action: "failed", sfId: oppRes.id, error: `quote: ${JSON.stringify(quoteRes.errors ?? quoteRes)} — the opportunity WAS created, re-run to finish it` };
  }
  out.steps.push(`Quote ${quoteRes.id}`);

  const lineRes = await ctx.conn.sobject("QuoteLineItem").create({
    QuoteId: quoteRes.id,
    PricebookEntryId: pbe.Id,
    Product2Id: pbe.Product2Id,
    Quantity: 1,
    UnitPrice: pbe.UnitPrice ?? 500,
    PriceOverride__c: true,
    PriceOverrideAmount__c: contract,
  });
  if (!lineRes.success) {
    return { ...out, action: "failed", sfId: oppRes.id, error: `line: ${JSON.stringify(lineRes.errors ?? lineRes)} — re-run to finish it` };
  }
  out.steps.push(`line ${contract.toFixed(2)}`);

  await ctx.conn.sobject("Quote").update({ Id: quoteRes.id, Status: "Approved" });
  out.steps.push("quote approved");

  /*
   * 🔴 THE MAP ROW, OR TONIGHT'S IMPORT DUPLICATES THE DEAL.
   *
   * `SF.opps` is scoped `Corporate_Name__c = 'Tomco Painting'`, so a record
   * this function creates is in the importer's scope immediately. The importer
   * keys on the Salesforce 18-char id and knows nothing about
   * `UniqueExternalId__c` — so with no map row, `mapped("deal", newId)` is null
   * and `stageDeals` plain-INSERTs a SECOND commercial_opportunities row.
   * Nothing constrains it. The first version of this function set the external
   * id and stopped, which would have produced exactly that on the next run.
   *
   * Stamped at the EPOCH for the same reason pairing is: a fresh stamp makes
   * `editedHere()` read the Command Center row as untouched, and Salesforce
   * wins the next night — overwriting the contract value with the $500
   * placeholder, the status, and the created date.
   */
  const { createClient: createAdmin } = await import("@supabase/supabase-js");
  const admin = createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });
  const { error: mapErr } = await admin.from("commercial_import_map").upsert(
    {
      sf_id: oppRes.id,
      entity: "deal",
      row_id: deal.id,
      notes: "created by the Tomco write-back",
      updated_at: new Date(0).toISOString(),
    },
    { onConflict: "sf_id,entity" },
  );
  if (mapErr) {
    return {
      ...out,
      action: "failed",
      sfId: oppRes.id,
      error:
        `Salesforce has the sale but the link did not save here (${mapErr.message}). ` +
        `FIX THIS BEFORE THE NEXT IMPORT — without it, tonight's run inserts a duplicate deal.`,
    };
  }
  out.steps.push("linked in the import map (epoch-stamped)");

  // ── read back ────────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 6000));
  const after = await soqlOne<{
    Name: string;
    StageName: string;
    Corporate_Name__c: string | null;
    Quote_Subtotal__c: number | null;
    AccountId: string | null;
  }>(
    ctx,
    `SELECT Name, StageName, Corporate_Name__c, Quote_Subtotal__c, AccountId FROM Opportunity WHERE Id = '${oppRes.id}'`,
  );
  out.checks.push({ name: "stage is Closed Won", ok: after?.StageName === "Closed Won", detail: after?.StageName ?? "unknown" });
  out.checks.push({
    name: "Corporate_Name__c is Tomco Painting",
    ok: after?.Corporate_Name__c === "Tomco Painting",
    detail: after?.Corporate_Name__c ?? "unset",
  });
  out.checks.push({
    name: "contract value arrived",
    ok: Math.abs(Number(after?.Quote_Subtotal__c ?? 0) - contract) < 0.005,
    detail: `Quote_Subtotal__c = ${after?.Quote_Subtotal__c ?? "null"} (sent ${contract.toFixed(2)})`,
  });
  out.checks.push({
    name: "carries the job's name, not a generated one",
    ok: (after as unknown as { Name?: string })?.Name === deal.title.slice(0, 120),
    detail: (after as unknown as { Name?: string })?.Name ?? "unknown",
  });
  out.checks.push({
    name: "hangs off an account",
    ok: !!after?.AccountId,
    detail: after?.AccountId ?? "ORPHAN — appears on no GC's page",
  });
  // Exactly one record carries this deal's id. The guard against the retry.
  const dupes = await ctx.conn.query(
    `SELECT COUNT(Id) n FROM Opportunity WHERE UniqueExternalId__c = '${deal.id}'`,
  );
  const n = Number((dupes.records?.[0] as { n?: number })?.n ?? 0);
  out.checks.push({ name: "exactly one record for this deal", ok: n === 1, detail: `${n} found` });
  return out;
}
