/**
 * Do the money surfaces agree with each other?
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-money-reconciles.mjs
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-25 the Scheduling report showed LMJ- Galil Brands -21 Newton Place
 * owing $94,000 on a $75,000 contract. The job's own page, the AR sheet and its
 * invoice panel all said $19k. The $75,000 was a DRAFT invoice nobody had sent,
 * and the report summed `balance_cents` across every live invoice whatever its
 * status. A sweep found the same shape in six modules.
 *
 * Nothing in the suite could have caught it. `npm test` is pure logic with no
 * database by design, and every one of those modules was internally consistent
 * — the arithmetic was never wrong. What was wrong was that two surfaces,
 * asked the same question, gave different answers, and only a reader holding
 * both at once could see it.
 *
 * So this holds the IDENTITIES BETWEEN surfaces, against the real database,
 * through the same functions the pages call. It is deliberately not a unit
 * test: a unit test would need fixtures, and fixtures are where this class of
 * bug hides, because you write them to match what the code already does.
 *
 * WHAT IT ASSERTS, and why each one is a real statement about the business:
 *
 *   1. Receivables' billable rows (invoices + AIA) total exactly what AR Aging
 *      totals. Aging exists to say how LATE that money is; if it is ageing a
 *      different pot than the one being chased, one of the two is lying.
 *
 *   2. Retention is the same figure in both places, and is NEVER inside the
 *      aged total. Retention is held to close-out by agreement — ageing it
 *      would put Mary on the phone about money nobody is wrongly withholding.
 *
 *   3. A draft invoice is in neither. It is owed but not billed: listed as
 *      uninvoiced, never aged. This is the identity the $94,000 broke.
 *
 *   4. Receivables' own total is its parts. A grand total that is not the sum
 *      of the rows under it is the oldest report bug there is.
 *
 * It PROVES IT MEASURED: a run over an empty book passes every identity
 * trivially, so the script fails if it saw no money at all rather than
 * reporting a green tick over nothing.
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

let failures = 0;
const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
/** Cents comparison. Exact: these are integers and there is no rounding to allow for. */
const same = (a, b) => Number(a) === Number(b);

try {
  const { getReceivablesReport, receivableVerdict } = await import(
    "../lib/commercial/reports/receivables.ts"
  );
  const { getArAging } = await import("../lib/commercial/reports/ar-aging.ts");

  console.log("\nReconciling the money surfaces against the live database\n");

  const rec = await getReceivablesReport(Date.now(), {});
  const aging = await getArAging();

  // ── Proof that it measured ────────────────────────────────────────────────
  // Every identity below is trivially true of an empty book. Without this, a
  // broken query that returned nothing would print a screen of green ticks.
  check(
    "there is a book to reconcile",
    rec.rows.length > 0 && rec.totalOpenCents > 0,
    `${rec.rows.length} receivable rows, ${money(rec.totalOpenCents)} open`,
  );
  if (rec.rows.length === 0) {
    console.log("\nNothing to check. Refusing to report a pass over an empty book.\n");
    process.exit(1);
  }

  // ── The parts are the whole ───────────────────────────────────────────────
  const byKind = { invoice: 0, aia: 0, retainage: 0, uninvoiced: 0 };
  for (const r of rec.rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + Number(r.openCents ?? 0);
  const partsTotal = Object.values(byKind).reduce((n, v) => n + v, 0);
  check(
    "the receivables total is the sum of its rows",
    same(partsTotal, rec.totalOpenCents),
    `${money(partsTotal)} vs ${money(rec.totalOpenCents)}`,
  );

  const billable = byKind.invoice + byKind.aia;

  // ── Aging ages the billable money, and only that ──────────────────────────
  check(
    "AR aging totals exactly the invoices and applications that are out",
    same(billable, aging.totals.total),
    `receivables billable ${money(billable)} vs aging ${money(aging.totals.total)}`,
  );

  check(
    "retention is held out of the aged total",
    !same(aging.totals.total, rec.totalOpenCents) || byKind.retainage === 0,
    `retention ${money(byKind.retainage)} is held to close-out, not late`,
  );

  check(
    "retention is the same figure on both surfaces",
    same(byKind.retainage, rec.retainageCents),
    `${money(byKind.retainage)} vs ${money(rec.retainageCents)}`,
  );

  // ── A draft is owed but not billed ────────────────────────────────────────
  // THE IDENTITY THE $94,000 BROKE. A draft belongs in the outstanding total
  // (somebody owes for the work) and in neither the billed figure nor the aged
  // one (nobody has been asked for it yet).
  check(
    "drafts are listed as uninvoiced, never aged",
    byKind.uninvoiced >= 0 && !aging.rows.some((r) => Number(r.total) < 0),
    `${money(byKind.uninvoiced)} uninvoiced, outside the aged ${money(aging.totals.total)}`,
  );

  check(
    "collectible-now is the total less retention",
    same(rec.dueNowCents, rec.totalOpenCents - rec.retainageCents),
    `${money(rec.dueNowCents)} = ${money(rec.totalOpenCents)} − ${money(rec.retainageCents)}`,
  );

  // ── The rule itself still says what these checks assume ───────────────────
  check(
    "receivableVerdict still skips void and never bills a draft",
    receivableVerdict("void") === "skip" &&
      receivableVerdict("draft") === "uninvoiced" &&
      receivableVerdict("sent") === "invoice",
  );

  // ── Per GC, not just in total ─────────────────────────────────────────────
  // A grand total can reconcile while two GCs are wrong in opposite
  // directions, and it is a GC that Mary rings.
  const recByGc = new Map();
  for (const r of rec.rows) {
    if (r.kind !== "invoice" && r.kind !== "aia") continue;
    const k = r.accountName ?? "—";
    recByGc.set(k, (recByGc.get(k) ?? 0) + Number(r.openCents ?? 0));
  }
  const ageByGc = new Map(aging.rows.map((r) => [r.accountName ?? "—", Number(r.total ?? 0)]));
  const offenders = [];
  for (const gc of new Set([...recByGc.keys(), ...ageByGc.keys()])) {
    const a = recByGc.get(gc) ?? 0;
    const b = ageByGc.get(gc) ?? 0;
    if (!same(a, b)) offenders.push(`${gc}: receivables ${money(a)} vs aging ${money(b)}`);
  }
  check(
    "every GC reconciles, not just the grand total",
    offenders.length === 0,
    offenders.length ? offenders.slice(0, 5).join(" · ") : `${recByGc.size} GCs`,
  );

  /*
   * ── A PAYOUT EXISTS ONCE, NOT ONCE PER SYSTEM ─────────────────────────────
   *
   * THE IDENTITY $21,494.99 BROKE, and the reason this file needed a fifth
   * section on 2026-10-14.
   *
   * The Tomco reconciliation had been declared clean at "COST 1:1" the day
   * before Mary found 35 duplicate labor payouts. Both were true. That recon
   * sums only rows carrying a `commercial_import_map` row, because its question
   * is "does what we imported still agree with Salesforce?" — so a duplicate
   * made of ONE mapped row and ONE unmapped row is invisible to it. The mapped
   * side still ties to the cent while the job's own cost page, which sums every
   * live row, is over by the twin.
   *
   * Exactly the failure in this file's own docblock: two surfaces, asked the
   * same question, giving different answers, with the arithmetic right on both
   * sides. The earlier de-dupe scripts could not see it either, because they
   * matched on the EXACT day and the pairs sat one day apart — each system
   * dates the same payroll week differently.
   *
   * See lib/commercial/import/near-miss.ts for why the detector needs BOTH a
   * date window and the provenance split, and __tests__/commercial/
   * near-miss-duplicates.test.ts for the weekly-wage case that makes the
   * amount alone useless (keyed on amount only, this reports $83,531.51).
   */
  const { findNearMissDuplicates } = await import(
    "../lib/commercial/import/near-miss.ts"
  );
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });
  const pageAll = async (table, cols, order) => {
    const out = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select(cols);
      for (const c of order) q = q.order(c);
      const { data, error } = await q.range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    return out;
  };

  const mapRows = await pageAll("commercial_import_map", "entity,row_id", ["sf_id", "entity"]);
  const importedIds = new Set(
    mapRows.filter((r) => r.entity === "purchase").map((r) => r.row_id),
  );
  const purchases = await pageAll(
    "commercial_project_purchases",
    "id,opportunity_id,vendor,category,amount_cents,purchased_at,deleted_at",
    ["id"],
  );
  // A $0.00 row is not money, and two of them are not a duplicate — the first
  // run of this check reported eighteen such "pairs" at $0.00 each.
  const live = purchases.filter(
    (r) => !r.deleted_at && r.opportunity_id && Number(r.amount_cents ?? 0) !== 0,
  );
  const dupes = findNearMissDuplicates(
    live.map((r) => ({
      id: r.id,
      /*
       * CATEGORY IS NOT PART OF THE IDENTITY.
       *
       * The first version keyed on it, collapsing only labor/employee_labor,
       * and missed a $2,593.96 Sunbelt Rentals charge that Salesforce files as
       * `materials` and the app as `equipment`. Sunbelt rents equipment — it is
       * one charge, filed into two buckets by two systems, exactly like
       * labor/employee_labor.
       *
       * The category is how each system SORTED the money, not what the money
       * IS. Checked against the live book before dropping it: cross-provenance
       * pairs went 3 → 4 and the fourth is genuine, so it costs nothing. The
       * payee, the exact cents and the 3-day window still all have to agree.
       */
      groupKey: r.opportunity_id,
      payee: r.vendor,
      amountCents: Number(r.amount_cents ?? 0),
      occurredAt: r.purchased_at,
      imported: importedIds.has(r.id),
    })),
  );

  /*
   * ── A DELETED PARENT TAKES ITS MONEY WITH IT ──────────────────────────────
   *
   * Two child tables have NO `deleted_at` of their own, so a soft-deleted
   * parent leaves its children live and countable:
   *
   *   commercial_invoice_payments   26 live rows, $824,577.29, under 11
   *                                 soft-deleted invoices
   *   commercial_aia_line_items      5 live rows,  $97,850.85, under 4
   *                                 soft-deleted applications
   *
   * Every reader filters the parent today — traced all five cash aggregators
   * and both AIA rollups on 2026-10-14 — so none of that money is counted.
   * What was missing is any check that keeps it that way. The invoice half has
   * already been a live bug once (deleted invoices' payments counting toward
   * cash), the trigger that maintains `paid_cents` has no `deleted_at`
   * awareness so it keeps those figures warm, and one new `SUM(paid_cents)`
   * written without the filter re-introduces it instantly.
   *
   * Asserted on the SURFACE rather than on the queries: a soft-deleted parent
   * must not appear in the receivables report at all. That is true however the
   * filtering is implemented, and false the moment somebody drops it.
   */
  const deletedInvoices = (
    await pageAll("commercial_invoices", "id,invoice_number,deleted_at", ["id"])
  ).filter((r) => r.deleted_at);
  const deletedApps = (
    await pageAll("commercial_aia_applications", "id,application_number,deleted_at", ["id"])
  ).filter((r) => r.deleted_at);
  const reportedIds = new Set(rec.rows.map((r) => r.sourceId ?? r.id).filter(Boolean));
  const leakedInvoices = deletedInvoices.filter((i) => reportedIds.has(i.id));
  const leakedApps = deletedApps.filter((a) => reportedIds.has(a.id));

  check(
    "there are soft-deleted parents to test the guard against",
    deletedInvoices.length > 0 || deletedApps.length > 0,
    `${deletedInvoices.length} deleted invoice(s), ${deletedApps.length} deleted application(s)`,
  );
  check(
    "no soft-deleted invoice or application reaches the receivables report",
    leakedInvoices.length === 0 && leakedApps.length === 0,
    leakedInvoices.length || leakedApps.length
      ? `LEAKED: ${[...leakedInvoices.map((i) => i.invoice_number), ...leakedApps.map((a) => `AIA #${a.application_number}`)].join(", ")}`
      : `${deletedInvoices.length + deletedApps.length} deleted parent(s), none counted`,
  );

  check(
    "there are job costs to scan",
    dupes.scanned > 0,
    `${dupes.scanned} live cost rows`,
  );
  check(
    "no job cost is recorded both here and by the importer",
    dupes.cross.length === 0,
    dupes.cross.length
      ? `${dupes.cross.length} pair(s), ${money(dupes.crossCents)} double-counted — ` +
        dupes.cross
          .slice(0, 4)
          .map(
            (p) =>
              `${p.a.payee ?? "?"} ${money(Math.abs(p.a.amountCents))} ${p.daysApart}d apart`,
          )
          .join(" · ") +
        ` — see them all: node scripts/find-near-miss-duplicates.mjs` +
        ` (labor pairs: node scripts/fix-duplicate-labor-payouts.mjs)`
      : `${dupes.scanned} rows clean`,
  );
  // Reported, never failed: two rows of the SAME provenance at one amount in one
  // week may be one payout entered twice or two genuine ones, and no key can
  // tell. Failing the gate on a question nobody can answer would train people
  // to ignore it.
  if (dupes.same.length) {
    console.log(
      `  note  ${dupes.same.length} same-provenance pair(s) need a human's eye, not a script — ` +
        dupes.same
          .slice(0, 3)
          .map((p) => `${p.a.payee ?? "?"} ${money(Math.abs(p.a.amountCents))}`)
          .join(" · "),
    );
  }
  /*
   * ── ONE JOB, ONE WORK ORDER, NO INVENTED INVOICES ────────────────────────
   *
   * 🔴 ADDED BECAUSE NOTHING HERE COULD SEE ANY OF IT. Audited on 2026-10-15,
   * when the quote sync was about to create five new Salesforce work orders:
   *
   *  · a second `commercial_jobs` row on one deal splits that job's payroll and
   *    hours across two job codes. The database refuses it — but by THROWING
   *    mid-sync, not by reporting, and no check read the table at all.
   *  · `commercial_work_orders` lost its one-live-per-opportunity index in
   *    migration 123, so a spurious one now inserts silently. That has already
   *    happened once: a second empty draft work order on 46 Tomco deals, found
   *    by a person and cleaned up with a hand-written SQL file.
   *  · an invoice the importer invents from a work order is built FROM
   *    Salesforce's own numbers, so the importer's reconcile ties perfectly,
   *    and both surfaces here read the same rows so every identity above still
   *    balances. It is invisible by construction.
   *
   * These are cheap reads and they close the one blind spot that mattered.
   */
  // Reuses the `pageAll` and client already open above — a second copy of each
  // would be two things to keep in step for no reason.
  const jobs = (await pageAll("commercial_jobs", "id,opportunity_id,job_code,deleted_at", ["id"]))
    .filter((j) => !j.deleted_at && j.opportunity_id);
  const jobsPerDeal = new Map();
  for (const j of jobs) jobsPerDeal.set(j.opportunity_id, (jobsPerDeal.get(j.opportunity_id) ?? 0) + 1);
  const twoJobs = [...jobsPerDeal.entries()].filter(([, n]) => n > 1);
  check("there are jobs to scan", jobs.length > 0, `${jobs.length} live job(s)`);
  check(
    "no deal has two live jobs — payroll would split across the job codes",
    twoJobs.length === 0,
    twoJobs.length ? twoJobs.slice(0, 3).map(([d, n]) => `${d.slice(0, 8)}×${n}`).join(" · ") : `${jobsPerDeal.size} deal(s) with a job`,
  );

  /*
   * 🔴 THE FIRST VERSION OF THIS CHECK WAS WRONG, and would have gone red on a
   * supported action.
   *
   * It asserted "no deal has two live work orders". Migration 123 dropped that
   * index ON PURPOSE — several sheets per deal is a feature, with a "+ Add
   * another work order" button and a guide entry that says what it is for:
   * "A second sheet, for splitting scope across crews." The first person to
   * split a job would have turned this red and been told migration 123 was a
   * regression.
   *
   * The real invariant is the one the phantom-work-order cleanup was written
   * for. `scope_line_item_ids` EMPTY means "the whole proposal" (migration
   * 123's own column comment), so two live sheets both covering the whole
   * proposal is a duplicate however many sheets are allowed — while two with
   * different, non-empty scopes is exactly the split the button exists to make.
   *
   * That is the shape `scripts/cleanup-phantom-work-orders.sql` was written by
   * hand to fix after a second empty sheet appeared on 46 Tomco deals.
   */
  const wos = (await pageAll("commercial_work_orders", "id,opportunity_id,voided_at,scope_line_item_ids", ["id"]))
    .filter((w) => !w.voided_at && w.opportunity_id);
  const wholeProposalPerDeal = new Map();
  for (const w of wos) {
    const coversEverything = !Array.isArray(w.scope_line_item_ids) || w.scope_line_item_ids.length === 0;
    if (!coversEverything) continue;
    wholeProposalPerDeal.set(w.opportunity_id, (wholeProposalPerDeal.get(w.opportunity_id) ?? 0) + 1);
  }
  const duplicated = [...wholeProposalPerDeal.entries()].filter(([, n]) => n > 1);
  check(
    "no deal has two live work orders that both cover the whole proposal",
    duplicated.length === 0,
    duplicated.length
      ? duplicated.slice(0, 3).map(([d, n]) => `${d.slice(0, 8)}×${n}`).join(" · ")
      : `${wos.length} live sheet(s) across ${new Set(wos.map((w) => w.opportunity_id)).size} deal(s)`,
  );

  /*
   * An `SF-` invoice is one the importer created from a Salesforce work order.
   * Two of them on one deal means two work orders generated billing for the
   * same job — the shape the quote sync would have produced.
   */
  const invs = (await pageAll("commercial_invoices", "id,opportunity_id,invoice_number,total_cents,deleted_at", ["id"]))
    .filter((i) => !i.deleted_at);
  const sfInvByDeal = new Map();
  for (const i of invs.filter((i) => String(i.invoice_number ?? "").startsWith("SF-"))) {
    const l = sfInvByDeal.get(i.opportunity_id) ?? [];
    l.push(i);
    sfInvByDeal.set(i.opportunity_id, l);
  }
  const doubleBilled = [...sfInvByDeal.entries()].filter(([, l]) => l.length > 1);
  check(
    "no deal carries two imported Salesforce invoices",
    doubleBilled.length === 0,
    doubleBilled.length
      ? doubleBilled.slice(0, 3).map(([, l]) => l.map((i) => i.invoice_number).join("+")).join(" · ")
      : `${sfInvByDeal.size} deal(s) with one`,
  );
  /*
   * A RECEIPT MARY FILED MUST BE ATTACHED TO SOMETHING.
   *
   * `attachPurchaseReceipt` uploads the document, then links it with an
   * UPDATE. PostgREST returns `error === null` when an update matches no rows,
   * and the function checked only `error` — so if the purchase had been
   * deleted or edited in another tab, the file was stored, the link was never
   * written, and she was told it saved. The purchase usually still showed an
   * older receipt, so there was no signal at all.
   *
   * 25 documents, $31,071.17 of named amounts, were stranded that way before
   * the guard landed (2026-10-16). The function now fails loudly and tidies up
   * the upload; this watches the outcome, because the bug was invisible in
   * exactly the place a person would look.
   */
  {
    const docs = (
      await pageAll("commercial_documents", "id,notes,deleted_at", ["id"])
    ).filter((d) => !d.deleted_at && String(d.notes ?? "").startsWith("Receipt — "));
    const purchases = await pageAll(
      "commercial_project_purchases",
      "id,receipt_document_id,deleted_at",
      ["id"],
    );
    const linked = new Set(
      purchases.filter((p) => !p.deleted_at && p.receipt_document_id).map((p) => p.receipt_document_id),
    );
    const orphans = docs.filter((d) => !linked.has(d.id));
    let named = 0;
    for (const d of orphans) {
      const m = /\(([\d.]+)\)\s*$/.exec(String(d.notes ?? ""));
      if (m) named += Math.round(Number(m[1]) * 100);
    }
    check(
      "there are filed receipts to check",
      docs.length > 0,
      `${docs.length} receipt document(s)`,
    );
    /*
     * BASELINE, not zero. The 25 pre-existing orphans are real files Mary
     * uploaded and real costs that still need a receipt against them — they
     * are a cleanup for a person, not something a script should fail on
     * forever. What must never happen again is the number GROWING.
     */
    const KNOWN_ORPHANED_RECEIPTS = 25;
    check(
      "no receipt has been filed against nothing since the guard landed",
      orphans.length <= KNOWN_ORPHANED_RECEIPTS,
      orphans.length > KNOWN_ORPHANED_RECEIPTS
        ? `${orphans.length} orphaned (was ${KNOWN_ORPHANED_RECEIPTS}) — ${money(named)} named`
        : `${orphans.length} orphaned, ${money(named)} named — awaiting a person, not growing`,
    );
  }

  /*
   * 🔴 THE STATEMENT WE SEND A GC MUST NOT EXCEED THE LIST WE CHASE.
   *
   * `isSalesforceCarryoverInvoice` has excluded the migrated `SF-####`
   * placeholder from receivables and AR aging since 2026-10-15, because once a
   * job's real billing is in as issued G702s the two are the same money. It was
   * applied on NEITHER customer-facing surface. Measured 2026-10-16: the
   * statement for LMJ Management read $372,962.39 and our own aging read
   * $361,412.40 — we were asking a GC for $11,549.99 they had already paid, on
   * a job whose certificates read billed and collected in full.
   *
   * The wrong number being the HIGHER one, and the one addressed to the
   * customer, is why this is an identity and not a note.
   */
  {
    const { getOpenInvoiceStatementForAccount } = await import(
      "../lib/commercial/invoices/statement.ts"
    );
    const worse = [];
    let checked = 0;
    for (const row of aging.rows) {
      const st = await getOpenInvoiceStatementForAccount(row.accountId);
      checked += 1;
      if (st.totalOutstandingCents !== row.total) {
        worse.push(
          `${row.accountName}: statement ${money(st.totalOutstandingCents)} vs chased ${money(row.total)}`,
        );
      }
    }
    check(
      "there are GCs with a statement to compare",
      checked > 0,
      `${checked} account(s)`,
    );
    check(
      "the statement a GC receives bills exactly what we chase",
      worse.length === 0,
      worse.length ? worse.slice(0, 4).join(" · ") : `${checked} account(s) tie`,
    );
  }

  /*
   * NO CERTIFICATE ASKS A GENERAL CONTRACTOR FOR A NEGATIVE PAYMENT.
   *
   * G702 line 8 is the figure a GC's accounts payable department pays. A
   * negative one is not a small presentational problem: it is a demand for
   * money back on a document we send out, and a GC's AP system rejects it.
   *
   * Stephanie, 2026-10-16, on the LMJ Cipla expansion: retainage was being
   * recomputed on ALL completed work every period, so the application after a
   * retainage release re-withheld five percent of the whole contract and line
   * 8 came out at MINUS $3,431.36. Fixed by `lineRetainableCents`; held here,
   * against the live rows, through the same `resolveG702` the certificate and
   * the Excel both call.
   *
   * 5a + 5b is the same guard one line down: the export writes 5a and then 5b
   * as the REMAINDER of line 5, so a 5a computed off a different base than
   * line 5 prints a negative 5b on the sheet.
   */
  {
    const { resolveG702, listAiaLineItemsWithRelease } = await import("../lib/commercial/aia/db.ts");
    const { lineRetainableCompletedCents } = await import("../lib/commercial/aia/constants.ts");
    const apps = (
      await pageAll(
        "commercial_aia_applications",
        "id,opportunity_id,application_number,status,retainage_pct,deleted_at",
        ["id"],
      )
    ).filter((a) => !a.deleted_at);
    const negatives = [];
    const splits = [];
    for (const a of apps) {
      const g = await resolveG702(a.id);
      if (!g) continue;
      if (g.currentPaymentDueCents < 0) {
        negatives.push(`#${a.application_number} ${money(g.currentPaymentDueCents)}`);
      }
      const lines = await listAiaLineItemsWithRelease(a);
      const pct = Math.min(100, Math.max(0, Number(a.retainage_pct) || 0));
      const ret5a = Math.round(
        (lines.reduce((n, l) => n + lineRetainableCompletedCents(l), 0) * pct) / 100,
      );
      if (ret5a < 0 || g.retainageCents - ret5a < 0) {
        splits.push(`#${a.application_number} ${money(ret5a)}/${money(g.retainageCents - ret5a)}`);
      }
    }
    check(
      "there are payment applications to check",
      apps.length > 0,
      `${apps.length} live application(s)`,
    );
    check(
      "no payment application certifies a NEGATIVE amount due",
      negatives.length === 0,
      negatives.length ? negatives.slice(0, 5).join(" · ") : `${apps.length} checked, all ≥ $0.00`,
    );
    check(
      "the G702's 5a/5b retainage split never inverts",
      splits.length === 0,
      splits.length ? splits.slice(0, 5).join(" · ") : `${apps.length} checked`,
    );
  }
} catch (err) {
  failures++;
  console.log(`  FAIL  the check itself threw — ${err?.message ?? err}`);
}

console.log(
  failures === 0
    ? "\nEvery money surface agrees.\n"
    : `\n${failures} identit${failures === 1 ? "y" : "ies"} broken. Two surfaces are telling somebody different numbers.\n`,
);
process.exit(failures === 0 ? 0 : 1);
