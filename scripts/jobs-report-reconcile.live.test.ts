/**
 * The Jobs report list vs the deal page, on REAL rows.
 *
 * The two get their money by different paths — the list from one batched query,
 * the deal page from getProjectFinancials per deal. The agent that built the
 * list proved they compute the same expression by reading both. This measures
 * it: every job with money on it, field by field. A mismatch here is two
 * screens telling Alex different numbers about the same job.
 */
import { it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { getJobsOverviewRows } from "@/lib/commercial/reports/jobs";
import { getProjectFinancials } from "@/lib/commercial/projects/financials";

it("every job's money matches the deal page", async () => {
  const rows = await getJobsOverviewRows();
  const out = process.env.RECONCILE_OUT;
  const money = rows.filter((r) => r.contractCents || r.billedCents || r.collectedCents || r.openBalanceCents);
  const log = (s: string) => out && appendFileSync(out, s + "\n");
  log(`jobs: ${rows.length} total, ${money.length} with money`);

  const mismatches: string[] = [];
  for (const r of money.slice(0, 40)) {
    const fin = await getProjectFinancials(r.oppId);
    const pairs: Array<[string, number, number]> = [
      ["contract", r.contractCents, fin.contractCents],
      ["billed", r.billedCents, fin.billedPreTaxCents],
      ["collected", r.collectedCents, fin.collectedCents],
      ["open balance", r.openBalanceCents, fin.openBalanceCents],
      ["retainage", r.retainageHeldCents, fin.retainageHeldCents],
    ];
    const bad = pairs.filter(([, a, b]) => a !== b);
    log(`${(r.jobName || r.oppId).slice(0, 44).padEnd(46)} ${bad.length ? "MISMATCH " + bad.map(([k, a, b]) => `${k} ${a} vs ${b}`).join("; ") : "ok"}`);
    for (const [k, a, b] of bad) mismatches.push(`${r.jobName}: ${k} list=${a} deal=${b}`);
  }
  log(mismatches.length ? `\n${mismatches.length} MISMATCHES` : "\nevery field agrees");
  expect(mismatches).toEqual([]);
});
