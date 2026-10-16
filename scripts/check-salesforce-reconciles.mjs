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
 * So "1:1" is a claim about SALES and CHANGE ORDERS, and nothing else. This
 * holds that claim to the cent, against the live org, so a drift is found by a
 * script rather than by somebody noticing a number looks odd.
 *
 * THREE WAYS THIS COMPARISON GOES WRONG, all of which it got wrong first:
 *
 *  1. MIXED BASIS. `accepted_contract_cents` is the BASE contract;
 *     `QuotedSubtotalWithChangeOrder__c` is the canonical sales metric and
 *     INCLUDES change orders. Comparing one to the other reported 19 deals in
 *     disagreement when 137 of 140 agreed exactly — the difference on each was
 *     precisely that deal's own change orders. Ours must be base + approved COs.
 *
 *  2. THE SILENT 1000-ROW CAP. A bare PostgREST select returns at most 1000
 *     rows with no error and no marker. `commercial_import_map` holds 5,802;
 *     an uncapped read saw 1,000 of them, the entity counts summed to exactly
 *     1000, and the run reported "0 change orders pushed" when 15 were. Every
 *     read here pages explicitly.
 *
 *  3. A DROPPED ERROR. `const { data } = await sb...` on a column that does not
 *     exist yields `data === null`, which reads as "no rows" rather than "the
 *     query was rejected". Three probes failed that way in one day, one of them
 *     reporting 0 affected deals when the answer was 4. Every read below
 *     destructures `error` and throws.
 *
 * WHAT IS *MEANT* TO DIFFER, and is not a failure:
 *
 *  · Rollup change orders. Rows titled "Approved change orders" came FROM
 *    Salesforce's own rollup field; pushing them back would count the same
 *    money twice, so `ROLLUP_TITLE` excludes them from the write-back by
 *    design. They are reported and not counted against the tally.
 *
 *  · A deal Salesforce already has as Closed Won. The write-back reports and
 *    stops rather than restating it — "the difference is Salesforce's to
 *    keep". Those are listed so a person can look, never failed.
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
const { ROLLUP_TITLE, CO_MAP_ENTITY } = await import("../lib/salesforce/tomco-changeorder.ts");

const sb = commercialDb();
let failures = 0;
const money = (c) => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const dollars = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

try {
  console.log("\nReconciling the Command Center against Salesforce\n");
  const conn = await getSalesforceClient();

  const maps = await all("commercial_import_map", "row_id, sf_id, entity", "sf_id");
  const dealMap = maps.filter((m) => m.entity === "deal");
  const coMapped = new Set(maps.filter((m) => m.entity === CO_MAP_ENTITY).map((m) => m.row_id));

  /*
   * PROOF THAT IT MEASURED. Every assertion below is trivially true of an
   * empty read, and an empty read is exactly what the 1000-row cap and a
   * dropped error both look like. 5,802 rows is the live figure; anything at
   * or under 1000 means the paging silently stopped.
   */
  check(
    "the import map was read in full, not capped",
    maps.length > 1000 && dealMap.length > 0,
    `${maps.length} map rows · ${dealMap.length} deals · ${coMapped.size} pushed change orders`,
  );
  if (maps.length <= 1000) {
    console.log("\nRefusing to report a pass over a read that may have been capped.\n");
    process.exit(1);
  }

  const deals = await all("commercial_opportunities", "id, title, accepted_contract_cents, deleted_at", "id");
  const cos = await all("commercial_change_orders", "id, opportunity_id, co_number, title, amount_cents, status, deleted_at", "id");
  const dealById = new Map(deals.map((d) => [d.id, d]));

  // Ours, on Salesforce's basis: base contract PLUS approved change orders.
  const coByOpp = new Map();
  for (const c of cos) {
    if (c.deleted_at || c.status !== "approved") continue;
    coByOpp.set(c.opportunity_id, (coByOpp.get(c.opportunity_id) ?? 0) + Number(c.amount_cents));
  }

  const ids = dealMap.map((m) => m.sf_id).filter(Boolean);
  const opps = [];
  for (let i = 0; i < ids.length; i += 150) {
    const q =
      `SELECT Id, Name, StageName, QuotedSubtotalWithChangeOrder__c FROM Opportunity ` +
      `WHERE Id IN (${ids.slice(i, i + 150).map((x) => `'${x}'`).join(",")})`;
    opps.push(...(await conn.query(q)).records);
  }
  const sfById = new Map(opps.map((o) => [o.Id, o]));
  check(
    "Salesforce answered for every linked deal",
    opps.length === ids.length,
    `${opps.length} of ${ids.length}`,
  );

  // ── Deals ────────────────────────────────────────────────────────────────
  let agree = 0;
  const differ = [];
  for (const m of dealMap) {
    const d = dealById.get(m.row_id);
    const o = sfById.get(m.sf_id);
    if (!d || d.deleted_at || !o) continue;
    const ours = (Number(d.accepted_contract_cents ?? 0) + Number(coByOpp.get(d.id) ?? 0)) / 100;
    const theirs = Number(o.QuotedSubtotalWithChangeOrder__c ?? 0);
    if (Math.abs(ours - theirs) < 0.005) agree++;
    else differ.push({ ours, theirs, name: o.Name, stage: o.StageName });
  }
  const linked = agree + differ.length;
  check("there are linked deals to compare", linked > 0, `${linked} live, linked deals`);
  /*
   * A BASELINE, not zero. Three deals differ today and all three are known:
   * VCA West Islip and AIREF #1 carry Salesforce-only money the write-back
   * deliberately leaves alone, and IHOP Patchogue is a $500 deal never billed
   * here. What must not happen is the number GROWING — that is a new drift.
   */
  const KNOWN_DEAL_DIFFERENCES = 3;
  check(
    "no NEW deal has drifted from Salesforce",
    differ.length <= KNOWN_DEAL_DIFFERENCES,
    differ.length > KNOWN_DEAL_DIFFERENCES
      ? `${differ.length} differ (was ${KNOWN_DEAL_DIFFERENCES})`
      : `${agree} of ${linked} agree to the cent · ${differ.length} known differences`,
  );
  for (const d of differ.sort((a, b) => Math.abs(b.ours - b.theirs) - Math.abs(a.ours - a.theirs))) {
    console.log(
      `        ours ${dollars(d.ours).padStart(13)}  SF ${dollars(d.theirs).padStart(13)}` +
        `  Δ ${dollars(d.ours - d.theirs).padStart(12)}  ${String(d.name).slice(0, 38)}`,
    );
  }

  // ── Change orders ────────────────────────────────────────────────────────
  const liveApproved = cos.filter((c) => !c.deleted_at && c.status === "approved");
  const rollups = liveApproved.filter((c) => ROLLUP_TITLE.test(String(c.title ?? "").trim()));
  const real = liveApproved.filter((c) => !ROLLUP_TITLE.test(String(c.title ?? "").trim()));
  const unpushed = real.filter((c) => !coMapped.has(c.id));
  let rollupCents = 0;
  for (const c of rollups) rollupCents += Number(c.amount_cents);

  check(
    "there are change orders to compare",
    liveApproved.length > 0,
    `${liveApproved.length} approved + live`,
  );
  check(
    "every genuine approved change order reached Salesforce",
    unpushed.length === 0,
    unpushed.length
      ? unpushed.slice(0, 5).map((c) => `CO-${c.co_number} ${money(c.amount_cents)} "${String(c.title).slice(0, 28)}"`).join(" · ")
      : `${real.length} pushed · ${rollups.length} rollup row(s) correctly excluded (${money(rollupCents)})`,
  );
  /*
   * The rollups are excluded BY TITLE, which a person can edit. If somebody
   * renames one it stops being excluded and the write-back pushes money
   * Salesforce already counts. Worth knowing the set is stable.
   */
  check(
    "the rollup rows are still recognisable as rollups",
    rollups.length > 0,
    `${rollups.length} row(s) matching ${ROLLUP_TITLE}`,
  );
} catch (err) {
  failures++;
  console.log(`  FAIL  the check itself threw — ${err?.message ?? err}`);
}

console.log(
  failures === 0
    ? "\nSales and change orders reconcile with Salesforce.\n"
    : `\n${failures} check(s) failed. The two systems disagree about money.\n`,
);
process.exit(failures === 0 ? 0 : 1);
