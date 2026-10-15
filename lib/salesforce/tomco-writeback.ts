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
    Pricebook2Id: string | null;
  }>(
    ctx,
    `SELECT Id, StageName, Corporate_Name__c, Quote_Subtotal__c, Pricebook2Id
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
    return {
      ...out,
      action: "skipped",
      steps: [
        `already Closed Won in Salesforce at ${opp.Quote_Subtotal__c ?? "—"} — left alone` +
          (Math.abs(Number(opp.Quote_Subtotal__c ?? 0) - contract) >= 0.005
            ? `; our base is ${contract.toFixed(2)}, and the difference is Salesforce's to keep`
            : ""),
      ],
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
