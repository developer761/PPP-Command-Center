/**
 * Is the Command Center still 1:1 with Salesforce on the things it writes back?
 *
 *   npm run check:salesforce
 *
 * WHY THIS EXISTS
 *
 * The write-back pushes exactly four Salesforce objects — Opportunity, Quote,
 * QuoteLineItem and ChangeOrder__c. Everything else the platform does (AIA
 * billing, proposals, submittals, work orders raised here, costs, payroll)
 * has no write-back path at all and is not expected to appear over there.
 *
 * So "1:1" is a claim about the LINKED DEALS and their CHANGE ORDERS. This
 * holds that claim against the live org, deal by deal and FIELD BY FIELD, so a
 * drift is found by a script rather than by somebody noticing a number.
 *
 * 🔴 IT USED TO COMPARE ONE FIELD ON 98 OF 140 DEALS AND CALL THAT 1:1.
 *
 * Only the contract was compared, only on Closed Won deals; the 42 others were
 * "not sold yet" and skipped outright, and the name, the GC, the stage, the
 * close date, the record type, the external id and the quote were never looked
 * at on any of them. And the pass condition was `differ.length <= 2`, so ANY
 * two deals could differ — a new drift the day an old one was fixed read green.
 * Now every linked deal is compared on every field in
 * `lib/salesforce/tomco-reconcile.ts`, and a known difference is pinned to its
 * deal, its field and its exact figures (see KNOWN below).
 *
 * THREE WAYS THIS COMPARISON GOES WRONG, all of which it got wrong first:
 *
 *  1. MIXED BASIS. `accepted_contract_cents` is the BASE contract;
 *     `QuotedSubtotalWithChangeOrder__c` is the canonical sales metric and
 *     INCLUDES change orders. Ours must be base + approved COs.
 *
 *  2. THE SILENT 1000-ROW CAP. A bare PostgREST select returns at most 1000
 *     rows with no error and no marker. Every read here pages explicitly, and
 *     so does every SOQL read (`queryMore`).
 *
 *  3. A DROPPED ERROR. `const { data } = await sb...` on a column that does not
 *     exist yields `data === null`, which reads as "no rows". Every read below
 *     destructures `error` and throws.
 *
 * WHAT IS *MEANT* TO DIFFER, and is not a failure:
 *
 *  · Rollup change orders. Rows titled "Approved change orders" came FROM
 *    Salesforce's own rollup field; they are never pushed (that would count
 *    the money twice). They ARE counted in our change-order total, because
 *    they stand for Salesforce records.
 *
 *  · An owner on a deal the write-back did not create — Salesforce's to keep.
 *
 * READ-ONLY. It writes nothing to either system.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { commercialDb } = await import("../lib/commercial/db.ts");
const { getSalesforceClient } = await import("../lib/salesforce/client.ts");
const { ROLLUP_TITLE, CO_MAP_ENTITY, salesforceCounts } = await import("../lib/salesforce/tomco-changeorder.ts");
const { isSoldStatus } = await import("../lib/salesforce/tomco-pairing.ts");
const { assertSalesforceId } = await import("../lib/salesforce/soql.ts");
const { derivedOppName } = await import("../lib/commercial/opportunities/db.ts");
const { RECONCILE_FIELDS, INFORMATIONAL_FIELDS, reconcileDeal, classify, sfCents, fmtCents } = await import("../lib/salesforce/tomco-reconcile.ts");

const sb = commercialDb();
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

/** Paged, and it THROWS on a rejected query rather than returning nothing. */
async function all(table, cols, orderBy) {
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(cols).order(orderBy).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
    from += data.length;
  }
  return out;
}

/*
 * ─────────────────────────────────────────────────────────────────────────
 * KNOWN DIFFERENCES — pinned to deal + field + exact figures.
 *
 * Each one is a real disagreement with a diagnosis and a named person who has
 * to approve the correction. Being listed here does NOT make it agree: it is
 * still counted as a difference in the X/140 line. What it buys is that the
 * check does not fail on something already in hand, and does fail the moment
 * anything else moves — including either of these.
 * ─────────────────────────────────────────────────────────────────────────
 */
const VCA = "67cc129e-b856-4453-b5b5-93d1b12ab05b";
const AIREF1 = "8e559156-a728-481a-b995-f2652a8eb0bf";
const VCA_WHY =
  "SALESFORCE IS WRONG — it counts $14,625 twice. CO-32409 ($14,625, set by Brendan 2026-10-13) is exactly " +
  "Wallcovering $12,375 + Sprinkler Room $1,500 + Window Trim $750 — the same three items CO-32669 " +
  "(\"Wallcovering, Sprinker Room, Window Trim\", $20,375) carries, pushed 2026-10-16 after Stephanie " +
  "itemised them here (+ Touch-Ups $5,750, + CO-32668 Doctors Office $2,250). Correct total $68,375 = ours, " +
  "= the $22,625 Stephanie froze on AIA #1–#3. Fix: set CO-32409 Status__c to Denied in Salesforce.";
const VCA_OWNER = "Brendan confirms CO-32669 supersedes CO-32409; Stephanie confirms; Katie makes the change in Salesforce";
const AIREF_WHY =
  "OURS IS RIGHT ON CURRENT EVIDENCE. $283,082 is Salesforce's own live Approved quote line (Mary, 2026-04-02) and " +
  "the SOV on all five AIA certificates (Building 1 $275,582 + TI $7,500; #2 and #3 paid by LMJ), and Stephanie " +
  "set it twice (09-23, and 10-16 after a script reverted it). $286,695 is WorkOrder 00287819's stored " +
  "OriginalSubtotal__c from 2026-02-26 — the quote was replaced on 04-02, never synced, so the work order never " +
  "followed. No ChangeOrder__c explains the $3,613. Fix: WO 00287819 OriginalSubtotal__c 286,695 → 283,082.";
const AIREF_OWNER = "Stephanie confirms $283,082 is the Building 1 contract (no $3,613 change order); Katie makes the change in Salesforce";
/*
 * Three of Katie's own placeholder opportunities (created 2025-10-09, Closed
 * Won, $1,575–$2,625 each) carry the PPP "New" record type instead of Tomco.
 * Katie 2026-09-22: "Yes they should be Tomco records." The write-back never
 * changes a record type on an existing record, so it cannot fix these itself.
 */
const RT_WHY = "SALESFORCE IS OFF-RULE — Katie created this placeholder 2025-10-09 under the PPP \"New\" record type; her rule is that Tomco sales are Tomco records. The write-back never changes a record type on an existing record. Fix: RecordType → Tomco.";
const RT_OWNER = "Katie (her records; her rule)";
/*
 * North Shore Dental: entered twice during the dual run — Stephanie won it here
 * 2026-09-17, Mary closed it in Salesforce 2026-09-22. Same fiscal quarter (Q3
 * FY26), so no report moves. `Close_Date_Uneditable_after_Closed_Won_L` locks a
 * Closed Won close date and Katie's policy is that it is not updated.
 */
const NSD = "f50710c5-e8f9-4f65-aae0-c7569ba44c64";
const NSD_WHY =
  "DUAL ENTRY, BOTH DATES REAL — Stephanie won it here 2026-09-17; Mary closed it in Salesforce 2026-09-22, before the " +
  "write-back existed. Same fiscal quarter (Q3 FY26), so no report moves. Salesforce locks a Closed Won close date " +
  "(Close_Date_Uneditable_after_Closed_Won_L) and Katie's rule is that it is never updated. Leave both unless Katie wants it changed.";
const KNOWN = [
  { dealId: VCA, field: "contract", ours: "$68,375.00", theirs: "$83,000.00", reason: VCA_WHY, owner: VCA_OWNER },
  { dealId: VCA, field: "change_orders", ours: "$22,625.00", theirs: "$37,250.00", reason: VCA_WHY, owner: VCA_OWNER },
  { dealId: AIREF1, field: "contract", ours: "$283,082.00", theirs: "$286,695.00", reason: AIREF_WHY, owner: AIREF_OWNER },
  { dealId: AIREF1, field: "base", ours: "$283,082.00", theirs: "$286,695.00", reason: AIREF_WHY, owner: AIREF_OWNER },
  { dealId: "ce99e751-d814-4ceb-8ede-49cc9dbd98e3", field: "record_type", ours: "Tomco", theirs: "New", reason: RT_WHY, owner: RT_OWNER },
  { dealId: "acaab224-3b96-4415-b74b-29fe953b8a76", field: "record_type", ours: "Tomco", theirs: "New", reason: RT_WHY, owner: RT_OWNER },
  { dealId: "b0197d7f-b4cc-4496-bcbd-666cd331d249", field: "record_type", ours: "Tomco", theirs: "New", reason: RT_WHY, owner: RT_OWNER },
  { dealId: NSD, field: "close_date", ours: "2026-09-17", theirs: "2026-09-22", reason: NSD_WHY, owner: "Katie, only if she wants the Salesforce date moved" },
];

try {
  console.log("\nReconciling the Command Center against Salesforce, field by field\n");
  const conn = await getSalesforceClient();

  /** Every page of a SOQL result. A bare `query` stops at 2,000 records with no error. */
  async function soqlAll(q) {
    let r = await conn.query(q);
    const out = [...r.records];
    while (!r.done && r.nextRecordsUrl) {
      r = await conn.queryMore(r.nextRecordsUrl);
      out.push(...r.records);
    }
    return out;
  }
  async function inChunks(ids, build) {
    const out = [];
    for (let i = 0; i < ids.length; i += 150) {
      const part = ids.slice(i, i + 150).map((x) => `'${assertSalesforceId(x)}'`).join(",");
      out.push(...(await soqlAll(build(part))));
    }
    return out;
  }

  const maps = await all("commercial_import_map", "row_id, sf_id, entity, notes", "sf_id");
  const dealMap = maps.filter((m) => m.entity === "deal");
  const coLinks = maps.filter((m) => m.entity === CO_MAP_ENTITY);
  const coMapped = new Set(coLinks.map((m) => m.row_id));
  const accountMap = new Map(maps.filter((m) => m.entity === "account").map((m) => [m.sf_id, m.row_id]));

  /*
   * PROOF THAT IT MEASURED. Every assertion below is trivially true of an
   * empty read, and an empty read is exactly what the 1000-row cap and a
   * dropped error both look like.
   */
  check(
    "the import map was read in full, not capped",
    maps.length > 1000 && dealMap.length > 0,
    `${maps.length} map rows · ${dealMap.length} deals · ${coLinks.length} pushed change orders`,
  );
  if (maps.length <= 1000) {
    console.log("\nRefusing to report a pass over a read that may have been capped.\n");
    process.exit(1);
  }

  const deals = await all(
    "commercial_opportunities",
    "id, title, title_override, title_override_mode, client_name, property_street, account_id, status, sub_status, accepted_contract_cents, bid_value_low_cents, decided_at, ppp_job_number, deleted_at",
    "id",
  );
  const accounts = await all("commercial_accounts", "id, company_name, deleted_at", "id");
  const cos = await all("commercial_change_orders", "id, opportunity_id, co_number, title, amount_cents, status, deleted_at", "id");
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const acctName = new Map(accounts.map((a) => [a.id, a.company_name]));
  const liveAccount = new Set(accounts.filter((a) => !a.deleted_at).map((a) => a.id));
  /*
   * Which opportunities did the WRITE-BACK move to Closed Won? Its own audit
   * trail says so (a successful StageName write), plus anything it created.
   * Katie's close-date rule only makes sense on those, so it is read from the
   * evidence rather than guessed from a note.
   */
  const { data: stageWrites, error: stageErr } = await sb
    .from("sf_writes_audit")
    .select("sf_record_id, field_writes")
    .eq("triggered_by", "tomco_writeback")
    .eq("sf_object", "Opportunity")
    .eq("succeeded", true)
    .limit(5000);
  if (stageErr) throw new Error(`sf_writes_audit: ${stageErr.message}`);
  const closedByUs = new Set((stageWrites ?? []).filter((a) => a.field_writes?.StageName === "Closed Won").map((a) => a.sf_record_id));

  const coByOpp = new Map();
  for (const c of cos) {
    if (c.deleted_at || c.status !== "approved") continue;
    coByOpp.set(c.opportunity_id, (coByOpp.get(c.opportunity_id) ?? 0) + Number(c.amount_cents));
  }

  // ── Salesforce, every linked opportunity and what hangs off it ──────────
  const ids = dealMap.map((m) => m.sf_id).filter(Boolean);
  const opps = await inChunks(
    ids,
    (part) =>
      `SELECT Id, Name, StageName, IsClosed, IsWon, CloseDate, AccountId, Account.Name, Owner.Name, RecordType.Name, ` +
      `Corporate_Name__c, UniqueExternalId__c, SyncedQuoteId, Quote_Subtotal__c, QuotedSubtotalWithChangeOrder__c ` +
      `FROM Opportunity WHERE Id IN (${part})`,
  );
  const sfById = new Map(opps.map((o) => [o.Id, o]));
  check("Salesforce answered for every linked deal", opps.length === ids.length, `${opps.length} of ${ids.length}`);

  const wos = await inChunks(
    ids,
    (part) => `SELECT Id, WorkOrderNumber, Status, Opportunity__c FROM WorkOrder WHERE Opportunity__c IN (${part}) AND Status != 'Canceled'`,
  );
  const wosByOpp = new Map();
  for (const w of wos) wosByOpp.set(w.Opportunity__c, [...(wosByOpp.get(w.Opportunity__c) ?? []), w]);
  const woToOpp = new Map(wos.map((w) => [w.Id, w.Opportunity__c]));
  const sfCos = await inChunks(
    wos.map((w) => w.Id),
    (part) => `SELECT Id, Name, CostChange__c, Status__c, WorkOrder__c FROM ChangeOrder__c WHERE WorkOrder__c IN (${part})`,
  );
  const sfCoApprovedByOpp = new Map();
  for (const c of sfCos) {
    if (!salesforceCounts(c.Status__c)) continue;
    const opp = woToOpp.get(c.WorkOrder__c);
    sfCoApprovedByOpp.set(opp, (sfCoApprovedByOpp.get(opp) ?? 0) + (sfCents(c.CostChange__c) ?? 0));
  }
  const quotes = await inChunks(ids, (part) => `SELECT Id, OpportunityId, Status FROM Quote WHERE OpportunityId IN (${part})`);
  const lines = await inChunks(
    quotes.map((q) => q.Id),
    (part) => `SELECT QuoteId, PriceOverride__c, PriceOverrideAmount__c, TotalPrice__c FROM QuoteLineItem WHERE QuoteId IN (${part})`,
  );
  const linesByQuote = new Map();
  for (const l of lines) linesByQuote.set(l.QuoteId, [...(linesByQuote.get(l.QuoteId) ?? []), l]);
  const quotesByOpp = new Map();
  for (const q of quotes) {
    const ls = linesByQuote.get(q.Id) ?? [];
    quotesByOpp.set(q.OpportunityId, [
      ...(quotesByOpp.get(q.OpportunityId) ?? []),
      { status: q.Status, lines: ls.length, lineAmounts: ls.map((l) => Number(l.PriceOverride__c ? l.PriceOverrideAmount__c : l.TotalPrice__c ?? 0)) },
    ]);
  }

  // ── field by field ───────────────────────────────────────────────────────
  const rows = [];
  let externalStamped = 0;
  for (const m of dealMap) {
    const d = dealById.get(m.row_id);
    const o = sfById.get(m.sf_id);
    if (!d || !o) {
      check(`linked deal ${m.row_id.slice(0, 8)} has a row on both sides`, false, !d ? "missing here" : "missing in Salesforce");
      continue;
    }
    if (o.UniqueExternalId__c) externalStamped++;
    const accountName = d.account_id ? acctName.get(d.account_id) ?? null : null;
    const sold = isSoldStatus(d.status, d.sub_status);
    const ours = {
      id: d.id,
      name: derivedOppName(d, accountName),
      deleted: !!d.deleted_at,
      sold,
      closedUnsold: !sold && d.status === "pre_sale_closed",
      baseCents: d.accepted_contract_cents == null ? null : Number(d.accepted_contract_cents),
      approvedCoCents: Number(coByOpp.get(d.id) ?? 0),
      bidCents: d.bid_value_low_cents == null ? null : Number(d.bid_value_low_cents),
      decidedOn: d.decided_at ? String(d.decided_at).slice(0, 10) : null,
      accountId: d.account_id ?? null,
      accountName,
      jobNumber: d.ppp_job_number ?? null,
    };
    const sf = {
      id: o.Id,
      name: o.Name,
      stageName: o.StageName,
      isClosed: !!o.IsClosed,
      isWon: !!o.IsWon,
      closeDate: o.CloseDate ?? null,
      accountName: o.Account?.Name ?? null,
      ourAccountIdForSfAccount: o.AccountId && liveAccount.has(accountMap.get(o.AccountId)) ? accountMap.get(o.AccountId) : null,
      sfAccountLinkStale: !!o.AccountId && accountMap.has(o.AccountId) && !liveAccount.has(accountMap.get(o.AccountId)),
      ownerName: o.Owner?.Name ?? null,
      recordType: o.RecordType?.Name ?? null,
      corporateName: o.Corporate_Name__c ?? null,
      externalId: o.UniqueExternalId__c ?? null,
      syncedQuoteId: o.SyncedQuoteId ?? null,
      quoteSubtotal: o.Quote_Subtotal__c ?? null,
      canonical: o.QuotedSubtotalWithChangeOrder__c ?? null,
      approvedCoCents: Number(sfCoApprovedByOpp.get(o.Id) ?? 0),
      workOrderNumbers: (wosByOpp.get(o.Id) ?? []).map((w) => w.WorkOrderNumber),
      quotes: quotesByOpp.get(o.Id) ?? [],
    };
    rows.push({
      dealId: d.id,
      label: o.Name,
      verdicts: reconcileDeal(ours, sf, {
        createdByWriteBack: /^created by the Tomco write-back/.test(String(m.notes ?? "")),
        closedByWriteBack: closedByUs.has(o.Id) || /^created by the Tomco write-back/.test(String(m.notes ?? "")),
      }),
    });
  }

  const { classified, staleKnown } = classify(rows, KNOWN);
  const linked = rows.length;
  console.log(`\n  ${linked} linked deals · UniqueExternalId__c stamped on ${externalStamped}\n`);
  console.log("  field            agree   differ (known)   n/a   (* = a label no write path keeps in step: reported, never fails)");
  let newDiffs = 0;
  for (const f of RECONCILE_FIELDS) {
    const c = classified.filter((x) => x.verdict.field === f);
    const agree = c.filter((x) => x.kind === "agree" || x.kind === "resolved-known").length;
    const known = c.filter((x) => x.kind === "known").length;
    const fresh = c.filter((x) => x.kind === "NEW").length;
    const na = c.filter((x) => x.kind === "n/a").length;
    const info = c.filter((x) => x.kind === "info").length;
    newDiffs += fresh;
    const applicable = linked - na;
    console.log(
      `  ${(f + (INFORMATIONAL_FIELDS.has(f) ? "*" : "")).padEnd(15)} ${String(agree).padStart(4)}/${String(applicable).padEnd(4)}` +
        ` ${String(known + fresh + info).padStart(4)} (${known})` +
        `     ${String(na).padStart(3)}` +
        `${info ? `   ${info} reported only` : ""}` +
        `${fresh ? `   🔴 ${fresh} NEW` : ""}`,
    );
  }
  const dealsAllAgree = rows.filter((r) => r.verdicts.every((v) => v.status !== "differ")).length;
  console.log(`\n  deals that agree on EVERY applicable field: ${dealsAllAgree}/${linked}\n`);

  // Every difference, named — known ones with their reason and owner.
  const diffs = classified.filter((x) => x.kind === "known" || x.kind === "NEW");
  const rank = { NEW: 0, known: 1, info: 2 };
  for (const x of [...diffs, ...classified.filter((c) => c.kind === "info")].sort((a, b) =>
    a.kind === b.kind ? a.verdict.field.localeCompare(b.verdict.field) || a.label.localeCompare(b.label) : rank[a.kind] - rank[b.kind],
  )) {
    console.log(
      `   ${x.kind === "NEW" ? "NEW  " : x.kind === "known" ? "known" : "info "} ${x.verdict.field.padEnd(13)} ${String(x.label).slice(0, 42).padEnd(42)} ` +
        `${x.kind === "NEW" ? `[${x.dealId}] ` : ""}` +
        `ours ${x.verdict.ours.slice(0, 40)} · SF ${x.verdict.theirs.slice(0, 60)}${x.verdict.note ? ` — ${x.verdict.note}` : ""}`,
    );
  }
  const knownDeals = [...new Set(diffs.filter((x) => x.kind === "known").map((x) => x.dealId))];
  for (const id of knownDeals) {
    const k = KNOWN.find((x) => x.dealId === id);
    console.log(`\n   ↳ ${rows.find((r) => r.dealId === id)?.label}: ${k.reason}\n     Approves: ${k.owner}`);
  }

  check(
    "no deal differs from Salesforce on any field except the pinned, diagnosed ones",
    newDiffs === 0,
    newDiffs ? `${newDiffs} new difference(s) above` : `${diffs.length} known difference(s) on ${knownDeals.length} deal(s), each pinned to its exact figures`,
  );
  const resolved = classified.filter((x) => x.kind === "resolved-known");
  check(
    "every pinned known difference is still exactly as pinned",
    staleKnown.length === 0 && resolved.length === 0,
    resolved.length || staleKnown.length
      ? `${resolved.length} now agree, ${staleKnown.length} no longer match a linked deal — delete them from KNOWN`
      : `${KNOWN.length} pinned`,
  );

  /*
   * SAY WHY, NOT JUST HOW MUCH: a migrated rollup row deleted here while
   * Salesforce still counts the records it stood for. That is how VCA West
   * Islip began — and it is armed on every deal that still carries one.
   */
  const deletedRollupsByOpp = new Map();
  for (const c of cos) {
    if (!c.deleted_at || !ROLLUP_TITLE.test(String(c.title ?? "").trim())) continue;
    deletedRollupsByOpp.set(c.opportunity_id, [...(deletedRollupsByOpp.get(c.opportunity_id) ?? []), c]);
  }
  for (const [oppId, rs] of deletedRollupsByOpp) {
    const m = dealMap.find((x) => x.row_id === oppId);
    if (!m) continue;
    for (const r of rs)
      console.log(
        `   ↳ ${String(sfById.get(m.sf_id)?.Name ?? oppId).slice(0, 40)}: a rollup row of ${fmtCents(Number(r.amount_cents))} ` +
          `was deleted here on ${String(r.deleted_at).slice(0, 10)}; the Salesforce records it stood for are unchanged`,
      );
  }

  // ── every pushed change order, pair by pair ─────────────────────────────
  const linkedSf = await inChunks(
    coLinks.map((l) => l.sf_id),
    (part) => `SELECT Id, Name, CostChange__c, Status__c FROM ChangeOrder__c WHERE Id IN (${part})`,
  );
  const linkedSfById = new Map(linkedSf.map((c) => [c.Id, c]));
  const coById = new Map(cos.map((c) => [c.id, c]));
  const pairBad = [];
  for (const l of coLinks) {
    const ours = coById.get(l.row_id);
    const theirs = linkedSfById.get(l.sf_id);
    const shouldCount = !!ours && !ours.deleted_at && ours.status === "approved";
    if (!ours || !theirs) {
      pairBad.push(`${l.sf_id}: ${!ours ? "no change order here" : "Salesforce does not return it"}`);
      continue;
    }
    if (salesforceCounts(theirs.Status__c) !== shouldCount) pairBad.push(`${theirs.Name}: ours ${ours.status}${ours.deleted_at ? " (deleted)" : ""}, SF ${theirs.Status__c}`);
    else if (shouldCount && sfCents(theirs.CostChange__c) !== Number(ours.amount_cents))
      pairBad.push(`${theirs.Name}: ours ${fmtCents(Number(ours.amount_cents))}, SF ${fmtCents(sfCents(theirs.CostChange__c))}`);
  }
  check(
    "every pushed change order agrees with its Salesforce record (status and amount)",
    pairBad.length === 0 && coLinks.length > 0,
    pairBad.length ? pairBad.join(" · ") : `${coLinks.length - pairBad.length}/${coLinks.length} agree`,
  );

  // ── Change orders ────────────────────────────────────────────────────────
  const liveApproved = cos.filter((c) => !c.deleted_at && c.status === "approved");
  const rollups = liveApproved.filter((c) => ROLLUP_TITLE.test(String(c.title ?? "").trim()));
  const real = liveApproved.filter((c) => !ROLLUP_TITLE.test(String(c.title ?? "").trim()));
  const unpushed = real.filter((c) => !coMapped.has(c.id));
  let rollupCents = 0;
  for (const c of rollups) rollupCents += Number(c.amount_cents);

  check("there are change orders to compare", liveApproved.length > 0, `${liveApproved.length} approved + live`);
  check(
    "every genuine approved change order reached Salesforce",
    unpushed.length === 0,
    unpushed.length
      ? unpushed.slice(0, 5).map((c) => `CO-${c.co_number} ${fmtCents(Number(c.amount_cents))} "${String(c.title).slice(0, 28)}"`).join(" · ")
      : `${real.length} pushed · ${rollups.length} rollup row(s) correctly excluded (${fmtCents(rollupCents)})`,
  );
  /*
   * The rollups are excluded BY TITLE, which a person can edit. If somebody
   * renames one it stops being excluded and the write-back pushes money
   * Salesforce already counts. Worth knowing the set is stable.
   */
  check("the rollup rows are still recognisable as rollups", rollups.length > 0, `${rollups.length} row(s) matching ${ROLLUP_TITLE}`);
} catch (err) {
  failures++;
  console.log(`  FAIL  the check itself threw — ${err?.message ?? err}`);
}

console.log(
  failures === 0
    ? "\nEvery linked deal and change order reconciles with Salesforce, apart from the pinned differences named above.\n"
    : `\n${failures} check(s) failed. The two systems disagree.\n`,
);
process.exit(failures === 0 ? 0 : 1);
