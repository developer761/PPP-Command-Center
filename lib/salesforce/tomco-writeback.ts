import "server-only";

import { getSalesforceClient } from "@/lib/salesforce/client";
import { logSfCreate, writeSf } from "@/lib/salesforce/writeback";
import { assertSalesforceId } from "@/lib/salesforce/soql";
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
  /**
   * `adopted`: Salesforce already had this sale under OUR external id and the
   * link row here had been lost — re-linked, nothing created.
   * `held`: a person has to look; `error` says what at.
   */
  action: "updated" | "created" | "adopted" | "skipped" | "held" | "failed";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A Command Center deal id, or a thrown error — it goes into SOQL as the
 * external id, and like a Salesforce id it is never a place for an escape.
 */
export function assertDealId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`deal id is not a uuid: ${JSON.stringify(String(id).slice(0, 40))}`);
  return id;
}

/** The note a link row carries when the write-back built the Salesforce side. */
export const CREATED_LINK_NOTE = "created by the Tomco write-back";

/**
 * Link a deal to its Salesforce opportunity in the import map.
 *
 * Stamped at the EPOCH for the same reason pairing is: a fresh stamp makes
 * `editedHere()` read the Command Center row as untouched, and Salesforce
 * would win the next import — overwriting the contract value with the $500
 * placeholder, the status, and the created date.
 */
async function linkDeal(sfId: string, dealId: string, notes: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { createClient: createAdmin } = await import("@supabase/supabase-js");
  const admin = createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin
    .from("commercial_import_map")
    .upsert(
      { sf_id: sfId, entity: "deal", row_id: dealId, notes, updated_at: new Date(0).toISOString() },
      { onConflict: "sf_id,entity" },
    )
    .select("sf_id");
  if (error) return { ok: false, error: error.message };
  // An upsert that touched nothing is not a link. Reported, not believed.
  if (!data || data.length === 0) return { ok: false, error: "the upsert returned no row" };
  return { ok: true };
}

/**
 * What a sale the write-back BUILT is missing, if anything.
 *
 * Katie's order, 2026-10-15: "Account -> Opportunity -> Quote w/ Line Items ->
 * Approve then Sync Quote". A create that fails part-way leaves a Closed Won
 * opportunity with some of that missing — and the next tick, finding Closed
 * Won, used to report "already Closed Won — left alone" and mark it VERIFIED.
 * That is how a half-built sale would have gone green. Pure, so the rule has a
 * test.
 */
export function missingFromOwnBuild(input: {
  stageName: string | null;
  syncedQuoteId: string | null;
  quotes: Array<{ id: string; status: string | null; lines: number }>;
}): string[] {
  const missing: string[] = [];
  if (input.stageName !== "Closed Won") missing.push(`stage is ${input.stageName ?? "unset"}, not Closed Won`);
  if (input.quotes.length === 0) missing.push("no quote");
  else if (input.quotes.length > 1) missing.push(`${input.quotes.length} quotes, expected one`);
  else {
    const q = input.quotes[0];
    if (q.lines === 0) missing.push("the quote has no line item");
    if (q.status !== "Approved") missing.push(`the quote is ${q.status ?? "unset"}, not Approved`);
    if (input.syncedQuoteId !== q.id) missing.push("the quote is not synced to the opportunity");
  }
  return missing;
}

async function inspectOwnBuild(ctx: Ctx, sfId: string): Promise<string[]> {
  const id = assertSalesforceId(sfId, "opportunity id");
  const opp = await soqlOne<{ StageName: string | null; SyncedQuoteId: string | null }>(
    ctx,
    `SELECT StageName, SyncedQuoteId FROM Opportunity WHERE Id = '${id}'`,
  );
  const qs = ((await ctx.conn.query(`SELECT Id, Status FROM Quote WHERE OpportunityId = '${id}'`)).records ?? []) as Array<{
    Id: string;
    Status: string | null;
  }>;
  const quotes: Array<{ id: string; status: string | null; lines: number }> = [];
  for (const q of qs) {
    const n = await ctx.conn.query(`SELECT COUNT() FROM QuoteLineItem WHERE QuoteId = '${assertSalesforceId(q.Id, "quote id")}'`);
    quotes.push({ id: q.Id, status: q.Status, lines: Number(n.totalSize ?? 0) });
  }
  return missingFromOwnBuild({ stageName: opp?.StageName ?? null, syncedQuoteId: opp?.SyncedQuoteId ?? null, quotes });
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
  opts: {
    /** The link row says the write-back built this record (see CREATED_LINK_NOTE). */
    builtByWriteBack?: boolean;
  } = {},
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
       FROM Opportunity WHERE Id = '${assertSalesforceId(sfId, "opportunity id")}'`,
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
  if (opp.StageName === "Closed Won" && opts.builtByWriteBack) {
    /*
     * 🔴 A SALE WE BUILT, CHECKED FOR BEING WHOLE BEFORE IT IS CALLED DONE.
     *
     * `createNew` links the record the moment the opportunity exists (F23), so
     * a create that fails afterwards — the quote, its line, the approval, the
     * sync — comes back here on the retry. This branch used to call that
     * "already Closed Won — left alone" and mark it verified. It is held for a
     * person instead, with exactly what is missing, and nothing is written:
     * finishing or rebuilding a half-made sale in Tomco's org is not a decision
     * the sync makes unattended.
     */
    const missing = await inspectOwnBuild(ctx, sfId);
    if (missing.length > 0) {
      return {
        ...out,
        action: "held",
        error:
          `The write-back built ${sfId} but it is incomplete: ${missing.join("; ")}. Nothing was written. ` +
          `Somebody finishes it in Salesforce (Account → Opportunity → Quote with line → Approved → Sync), then re-checks it here.`,
      };
    }
  }
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
    /*
     * 🔴 A SKIP IS STILL A VERIFICATION, and saying so is what lets a failed
     * one ever go green again.
     *
     * This returned `checks: []`. `finishDeal` sets `verified` from
     * `checks.length > 0`, so a skip cleared nothing — and a skip is the state
     * every successfully written deal settles into. So once a read-back had
     * failed once (the six-second wait beating the org's flow chain is enough
     * to do it), `verify_failed_at` could never be cleared by anything: the
     * only paths that clear it are the ones that stop happening the moment the
     * write succeeds. The review screen's "not verified" tile would have sat
     * red for ever on a record that was perfectly correct.
     *
     * We have just read the figures. Asserting them IS the verification.
     */
    return {
      ...out,
      action: "skipped",
      steps: [`already Closed Won in Salesforce at ${canonical.toFixed(2)} — left alone${note}`],
      checks: [
        { name: "stage is Closed Won", ok: true, detail: opp.StageName },
        /*
         * 🔴 THIS CHECK USED TO ASSERT `canonicalAgrees || quoteLineAgrees`,
         * WHICH IS FALSE IN EXACTLY THE STATE THE POLICY ABOVE CALLS CORRECT.
         *
         * Thirty lines up: "Those gaps are Salesforce knowing something we do
         * not ... the difference is Salesforce's to keep." The `note` built
         * just above literally writes that sentence out. Then the check failed
         * on it — and `finishDeal` treats a failed check as markVerifyFailed +
         * markFailed, so the deal burns an attempt every sweep, three times,
         * then stalls red and blocks every future entry for that deal. The code
         * verified the opposite of what it decided.
         *
         * It has never run: the check shipped at 2026-10-15T17:47Z and the last
         * sale entry finished at 17:25Z. Four of 98 linked deals are armed —
         * Amazon Waterproofing, 1 Rodeo Drive, 32 Ranick WH, Primrose/Avignone
         * — none queued today, so it fires the moment one of them is edited.
         *
         * A SKIP WROTE NOTHING, so there is nothing to verify beyond having
         * read the state correctly, which the first check does. The comparison
         * is INFORMATION for the review screen — and it already reaches a human
         * in words through `note` — not a pass/fail. Reported, never failed.
         */
        {
          name: "Salesforce's figures read back",
          ok: true,
          detail:
            `canonical ${canonical.toFixed(2)} · quote line ${quoteLine.toFixed(2)} · ours ${contract.toFixed(2)}` +
            (canonicalAgrees || quoteLineAgrees ? " — agrees" : " — differs, and that difference is Salesforce's to keep"),
        },
      ],
    };
  }
  /*
   * ── THE QUOTE IS SETTLED BEFORE THE STAGE IS TOUCHED ─────────────────────
   *
   * 🔴 THIS ORDER IS THE FIX. The stage was written to Closed Won FIRST and the
   * quote investigated afterwards, so every refusal below left a Closed Won
   * opportunity behind carrying no money:
   *
   *   · two quotes → returned "a person has to say which is the sale", with the
   *     stage already flipped
   *   · no quote → created a Draft one, then took the `ls.length === 0` arm and
   *     wrote NO line ("see the insert path"), and `qs[0]` was the pre-create
   *     array so the new quote was never approved either
   *
   * Either way: Closed Won at $0 in Katie's reports, the read-back's "contract
   * value arrived" check failing, three attempts burned, the entry stalled —
   * and the stage write standing. So the whole job is established as doable
   * before any of it is done.
   */
  const quotes = await ctx.conn.query(
    `SELECT Id, Status, Subtotal__c FROM Quote WHERE OpportunityId = '${assertSalesforceId(sfId, "opportunity id")}'`,
  );
  const qs = (quotes.records ?? []) as Array<{ Id: string; Status: string; Subtotal__c: number | null }>;
  if (qs.length > 1) {
    /*
     * Which quote IS the sale is not ours to decide — approving the wrong one
     * puts the wrong number on the opportunity. 31 Tomco opportunities sit at
     * "Estimate Sent / Quote Sent" with exactly one quote; more than one is
     * rare and worth a person.
     */
    return { ...out, action: "failed", error: `${qs.length} quotes on ${sfId} — a person has to say which is the sale. Nothing written.` };
  }
  if (qs.length === 0) {
    /*
     * No quote at all. This path cannot build one end-to-end — it writes no
     * line (the insert path owns that), so creating one here produced an
     * approved-looking sale with nothing on it. Refused, before anything is
     * written, so the opportunity is left exactly as Salesforce has it.
     */
    return {
      ...out,
      action: "failed",
      error:
        `${sfId} has no quote, and the money lives on a quote line. Nothing written — ` +
        `build the quote in Salesforce, or let this deal go in through the insert path.`,
    };
  }
  const quoteId = qs[0].Id;

  /*
   * 🔴 AND THE LINE, BEFORE THE STAGE — this is the half that was missing.
   *
   * The first version of this fix moved only the quote-COUNT checks above the
   * stage write and left the line checks below it, while the docblock above
   * claimed "the whole job is established as doable before any of it is done".
   * It was not: an itemised quote (four Tomco quotes genuinely are) and a quote
   * with no line both still returned `failed` with the opportunity already
   * flipped to Closed Won and no money on it.
   *
   * Worse, that state was self-erasing. The entry was marked failed; an hour
   * later the retry read `StageName === "Closed Won"`, returned `skipped` with
   * no checks, and `markDone` cleared `last_error`. A sale sitting at $0 in
   * Katie's reports ended up green, in none of the review screen's lists.
   *
   * Run in BOTH modes, unlike before: a plan run that cannot show you the
   * refusal is not a plan of what will happen.
   */
  const lines = await ctx.conn.query(
    `SELECT Id, PriceOverride__c, PriceOverrideAmount__c, TotalPrice__c FROM QuoteLineItem WHERE QuoteId = '${assertSalesforceId(quoteId, "quote id")}'`,
  );
  const ls = (lines.records ?? []) as Array<{ Id: string; PriceOverrideAmount__c: number | null }>;
  if (ls.length > 1) {
    // Four Tomco quotes are genuinely itemised. Spreading one contract figure
    // across them, or collapsing them to one, both destroy the breakdown.
    return {
      ...out,
      action: "failed",
      error: `${ls.length} lines on quote ${quoteId} — itemised, a person decides. Nothing written.`,
    };
  }
  if (ls.length === 0) {
    return {
      ...out,
      action: "failed",
      error:
        `Quote ${quoteId} has no line item, so the contract value would have nowhere to go. ` +
        `Nothing written — add a line in Salesforce and this will finish it.`,
    };
  }
  const line = ls[0];

  // Only now — with a quote, a line, and somewhere for the money to go — is
  // anything written at all.
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

  // ── the line, which is where the money lives ─────────────────────────────
  if (ctx.apply) {
    if (Number(line.PriceOverrideAmount__c ?? 0) === contract) {
      out.steps.push(`line already ${contract.toFixed(2)} — left alone`);
    } else {
      const res = await writeSf(
        { sObject: "QuoteLineItem", recordId: line.Id, fields: { PriceOverride__c: true, PriceOverrideAmount__c: contract } },
        { source: "tomco_writeback", triggeredByUserId: ctx.actorUserId, deferCacheInvalidation: true, priorValues: { PriceOverrideAmount__c: line.PriceOverrideAmount__c } },
      );
      if (!res.ok) return { ...out, action: "failed", error: `line: ${res.error}` };
      out.steps.push(`line ${line.PriceOverrideAmount__c ?? "—"} → ${contract.toFixed(2)}`);
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
         FROM Opportunity WHERE Id = '${assertSalesforceId(sfId, "opportunity id")}'`,
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
 * Every create here is made ONCE — never through `writeSf`, whose transport
 * retry would repeat a create that may already have landed. The defence is to
 * look the deal up by its external id immediately before inserting, and again
 * if the insert throws: `UniqueExternalId__c` is unique in the org, so a second
 * insert of the same deal is refused by Salesforce itself rather than landing.
 *
 * 🔴 AND WHAT IT FINDS IS ADOPTED, NOT IGNORED (F23).
 *
 * Finding the deal already there used to return "skipped" and write nothing
 * here — so the import map still had no row, every later tick took this insert
 * path again, and the importer (which keys on Salesforce's id and knows nothing
 * of the external id) would plain-INSERT a second deal on its next run. Now the
 * record is linked, and handed to the update path like any linked deal.
 *
 * 🔴 AND THE LINK IS WRITTEN THE MOMENT THE OPPORTUNITY EXISTS.
 *
 * It used to be written last, after the quote, its line, the approval and the
 * sync — and the approval was an unchecked `Quote.update` that could throw past
 * it. Any failure in between left a Closed Won opportunity in Salesforce with
 * no row here. Linking first means a later failure leaves a linked, half-built
 * record, which `updateExisting` recognises and holds for a person.
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
  const extId = assertDealId(deal.id);
  const findByExternalId = () =>
    soqlOne<{ Id: string; Name: string; StageName: string }>(
      ctx,
      `SELECT Id, Name, StageName FROM Opportunity WHERE UniqueExternalId__c = '${extId}'`,
    );

  // ── already there? Adopt it — never create a second ──────────────────────
  const already = await findByExternalId();
  if (already) {
    if (!ctx.apply) {
      return {
        ...out,
        action: "adopted",
        sfId: already.Id,
        steps: [`would link "${already.Name}" (${already.Id}) — Salesforce already has it under this deal's external id; nothing created`],
      };
    }
    const linked = await linkDeal(already.Id, deal.id, "linked by its UniqueExternalId__c — the link row here had been lost");
    if (!linked.ok) {
      return {
        ...out,
        action: "failed",
        sfId: already.Id,
        error: `Salesforce already has this sale (${already.Id}) but the link did not save here (${linked.error}). Nothing was created.`,
      };
    }
    const r = await updateExisting(ctx, deal, already.Id);
    return {
      ...r,
      action: r.action === "skipped" ? "adopted" : r.action,
      steps: [`re-linked ${already.Id} by its external id — nothing created`, ...r.steps],
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
       WHERE Pricebook2Id = '${assertSalesforceId(book.Id, "pricebook id")}' AND Product2.Name = 'Other' AND IsActive = true LIMIT 1`,
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

  /** One create, once, recorded in `sf_writes_audit` whatever happens. */
  const createOnce = async (
    sObject: string,
    fields: Record<string, unknown>,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    const t0 = Date.now();
    try {
      const res = (await ctx.conn.sobject(sObject).create(fields)) as { success?: boolean; id?: string; errors?: unknown };
      const ok = !!res.success && !!res.id;
      await logSfCreate({
        sObject,
        recordId: ok ? res.id! : null,
        fields,
        source: "tomco_writeback",
        triggeredByUserId: ctx.actorUserId,
        succeeded: ok,
        error: ok ? null : JSON.stringify(res.errors ?? res),
        durationMs: Date.now() - t0,
      });
      return ok ? { ok: true, id: res.id! } : { ok: false, error: JSON.stringify(res.errors ?? res) };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await logSfCreate({
        sObject,
        recordId: null,
        fields,
        source: "tomco_writeback",
        triggeredByUserId: ctx.actorUserId,
        succeeded: false,
        error,
        durationMs: Date.now() - t0,
      });
      return { ok: false, error };
    }
  };

  // ── the opportunity ──────────────────────────────────────────────────────
  // CloseDate IS sent here, and only here. It is required on insert
  // (nillable=0, defaultedOnCreate=0) and rejected on update, which is exactly
  // why this cannot be one upsert call.
  const opp = await createOnce("Opportunity", {
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
  if (!opp.ok) {
    /*
     * A thrown create is not proof nothing landed — a timeout can arrive after
     * the insert committed. Look before reporting, and link what is there, so
     * the retry does not create it again.
     */
    const landed = await findByExternalId();
    if (landed) {
      const linked = await linkDeal(landed.Id, deal.id, CREATED_LINK_NOTE);
      return {
        ...out,
        action: "failed",
        sfId: landed.Id,
        error:
          `the create reported "${opp.error}" but the opportunity landed (${landed.Id}); ` +
          (linked.ok ? "it is linked, and the retry finishes or holds it" : `and the link did not save (${linked.error}) — the retry re-links it by its external id`),
      };
    }
    return { ...out, action: "failed", error: `opportunity: ${opp.error}` };
  }
  out.sfId = opp.id;
  out.steps.push(`Opportunity ${opp.id}`);

  /*
   * 🔴 THE MAP ROW, NOW — OR TONIGHT'S IMPORT DUPLICATES THE DEAL.
   *
   * `SF.opps` is scoped `Corporate_Name__c = 'Tomco Painting'`, so a record
   * this function creates is in the importer's scope immediately, and the
   * importer keys on the Salesforce id. With no map row it plain-INSERTs a
   * SECOND commercial_opportunities row. So the link is the first thing done
   * after the record exists, not the last.
   */
  const linked = await linkDeal(opp.id, deal.id, CREATED_LINK_NOTE);
  if (!linked.ok) {
    return {
      ...out,
      action: "failed",
      error:
        `Salesforce has the sale (${opp.id}) but the link did not save here (${linked.error}). ` +
        `The next tick finds it by its external id and re-links it rather than creating a second.`,
    };
  }
  out.steps.push("linked in the import map (epoch-stamped)");

  /*
   * 🔴 SET THE NAME AGAIN. A FLOW OVERWRITES IT ON INSERT.
   *
   * We sent "Flagstar Bank Trash Enclosures" and Salesforce stored
   * "PCCI Builders Corp. Opp - 2026-10-14" — something on this object renames
   * an opportunity to "{Account} Opp - {date}" on create. Tested: the rename
   * HOLDS on a later update, so the fix is simply to say it twice. Through
   * `writeSf` now, so it is in the audit trail like every other update.
   */
  const wanted = deal.title.slice(0, 120);
  const named = await soqlOne<{ Name: string }>(ctx, `SELECT Name FROM Opportunity WHERE Id = '${assertSalesforceId(opp.id)}'`);
  if (named && named.Name !== wanted) {
    const res = await writeSf(
      { sObject: "Opportunity", recordId: opp.id, fields: { Name: wanted } },
      { source: "tomco_writeback", triggeredByUserId: ctx.actorUserId, deferCacheInvalidation: true, priorValues: { Name: named.Name } },
    );
    // Not fatal — the sale and its money are right, only the label is wrong.
    out.steps.push(res.ok ? `name restored (a flow had set it to "${named.Name}")` : `⚠ could not restore the name: ${res.error}`);
  }

  // ── the quote and its one line ───────────────────────────────────────────
  const halfBuilt = "the opportunity is in Salesforce and linked here; the retry holds it for a person to finish rather than building a second";
  const quote = await createOnce("Quote", {
    Name: deal.title.slice(0, 255),
    OpportunityId: opp.id,
    Pricebook2Id: book.Id,
    Status: "Draft",
  });
  if (!quote.ok) return { ...out, action: "failed", error: `quote: ${quote.error} — ${halfBuilt}` };
  out.steps.push(`Quote ${quote.id}`);

  const line = await createOnce("QuoteLineItem", {
    QuoteId: quote.id,
    PricebookEntryId: pbe.Id,
    Product2Id: pbe.Product2Id,
    Quantity: 1,
    UnitPrice: pbe.UnitPrice ?? 500,
    PriceOverride__c: true,
    PriceOverrideAmount__c: contract,
  });
  if (!line.ok) return { ...out, action: "failed", error: `line: ${line.error} — ${halfBuilt}` };
  out.steps.push(`line ${contract.toFixed(2)}`);

  /*
   * 🔴 CHECKED NOW. This was a bare `Quote.update` whose result nobody read and
   * whose throw escaped the function before the link was written (F23 a).
   */
  const approved = await writeSf(
    { sObject: "Quote", recordId: quote.id, fields: { Status: "Approved" } },
    { source: "tomco_writeback", triggeredByUserId: ctx.actorUserId, deferCacheInvalidation: true, priorValues: { Status: "Draft" } },
  );
  if (!approved.ok) return { ...out, action: "failed", error: `quote approval: ${approved.error} — ${halfBuilt}` };
  out.steps.push("quote approved");

  /*
   * 🔴 AND SYNC THE QUOTE, OR THE SALE READS AS $0 IN KATIE'S REPORTS.
   *
   * Katie, 2026-10-15: *"Account → Opportunity → Quote w/ Line Items → Approve
   * then Sync Quote and the automation should handle it from there forward."*
   * This is the "Sync Quote" step, which on the Opportunity is `SyncedQuoteId`.
   * Without it there is no work order, `QuotedSubtotalWithChangeOrder__c` stays
   * NULL, and no change order can ever attach.
   *
   * Best-effort on purpose: the read-back below fails the entry if it did not
   * take, and the retry then holds the half-built sale for a person.
   */
  const synced = await writeSf(
    { sObject: "Opportunity", recordId: opp.id, fields: { SyncedQuoteId: quote.id } },
    { source: "tomco_writeback", triggeredByUserId: ctx.actorUserId, deferCacheInvalidation: true, priorValues: { SyncedQuoteId: null } },
  );
  out.steps.push(
    synced.ok
      ? "quote synced — the org creates the work order from here"
      : `🔴 quote NOT synced (${synced.error}) — no work order will be created and this sale will read as $0 in the canonical total until it is`,
  );

  // ── read back ────────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 6000));
  const after = await soqlOne<{
    Name: string;
    StageName: string;
    Corporate_Name__c: string | null;
    Quote_Subtotal__c: number | null;
    SyncedQuoteId: string | null;
    AccountId: string | null;
  }>(
    ctx,
    `SELECT Name, StageName, Corporate_Name__c, Quote_Subtotal__c, SyncedQuoteId, AccountId FROM Opportunity WHERE Id = '${assertSalesforceId(opp.id)}'`,
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
    ok: after?.Name === wanted,
    detail: after?.Name ?? "unknown",
  });
  out.checks.push({
    name: "hangs off an account",
    ok: !!after?.AccountId,
    detail: after?.AccountId ?? "ORPHAN — appears on no GC's page",
  });
  // Exactly one record carries this deal's id. The guard against the retry.
  const dupes = await ctx.conn.query(`SELECT COUNT(Id) n FROM Opportunity WHERE UniqueExternalId__c = '${extId}'`);
  const n = Number((dupes.records?.[0] as { n?: number })?.n ?? 0);
  out.checks.push({ name: "exactly one record for this deal", ok: n === 1, detail: `${n} found` });

  /*
   * THE QUOTE IS SYNCED, AND A WORK ORDER FOLLOWED. Checked rather than assumed
   * because the first four records this function created were missing both,
   * and nothing said so. The work order is created by the org's own
   * automation, which is not instant — reported separately so "not yet"
   * reads differently from "never asked".
   */
  out.checks.push({
    name: "quote is synced to the opportunity",
    ok: !!after?.SyncedQuoteId,
    detail: after?.SyncedQuoteId
      ? after.SyncedQuoteId
      : "NOT synced — no work order will be created, and the canonical total stays empty",
  });
  const wo = await soqlOne<{ WorkOrderNumber: string; Status: string }>(
    ctx,
    `SELECT WorkOrderNumber, Status FROM WorkOrder WHERE Opportunity__c = '${assertSalesforceId(opp.id)}' AND Status != 'Canceled' LIMIT 1`,
  );
  out.checks.push({
    name: "a work order exists for it",
    ok: !!wo,
    detail: wo
      ? `${wo.WorkOrderNumber} (${wo.Status})`
      : "none yet — the org creates it from the synced quote, which can lag; re-check before approving change orders on this job",
  });
  return out;
}
