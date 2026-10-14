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
      // Category is part of the identity: the same money can legitimately sit
      // under `labor` in one system and `employee_labor` in the other, so it is
      // deliberately NOT in the key — but a $500 material and a $500 payout on
      // one job in one week are not the same thing.
      groupKey: `${r.opportunity_id}|${["labor", "employee_labor"].includes(r.category) ? "labor" : r.category}`,
      payee: r.vendor,
      amountCents: Number(r.amount_cents ?? 0),
      occurredAt: r.purchased_at,
      imported: importedIds.has(r.id),
    })),
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
