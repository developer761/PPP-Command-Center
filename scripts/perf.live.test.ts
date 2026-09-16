/** Where the Reports time actually goes, against the real data. */
import { it } from "vitest";
import { appendFileSync } from "node:fs";
const OUT = process.env.PERF_OUT!;
const log = (s: string) => appendFileSync(OUT, s + "\n");

it("times the report data layer", async () => {
  const time = async (label: string, fn: () => Promise<unknown>) => {
    const t = Date.now();
    const r = await fn();
    const n = Array.isArray(r) ? r.length : typeof r === "object" && r ? Object.keys(r).length : 0;
    log(`${String(Date.now() - t).padStart(6)}ms  ${label} (${n})`);
    return r;
  };
  const { listProjects } = await import("@/lib/commercial/projects/db");
  await time("listProjects (the spine of most reports)", () => listProjects({ includeClosed: true }));
  const { getJobCostsReport } = await import("@/lib/commercial/reports/job-costs");
  await time("getJobCostsReport", () => getJobCostsReport());
  const { getJobsOverviewRows } = await import("@/lib/commercial/reports/jobs");
  await time("getJobsOverviewRows", () => getJobsOverviewRows());
  const { getReceivablesReport } = await import("@/lib/commercial/reports/receivables");
  await time("getReceivablesReport", () => getReceivablesReport());
  const { getPipelineReport } = await import("@/lib/commercial/reports/pipeline");
  await time("getPipelineReport", () => getPipelineReport());

  // One job, end to end: the page Alex opens most, and the slowest one measured.
  const { commercialDb } = await import("@/lib/commercial/db");
  const { data } = await commercialDb()
    .from("commercial_opportunities")
    .select("id")
    .eq("status", "post_sale_closed")
    .limit(1);
  const oppId = (data as { id: string }[] | null)?.[0]?.id;
  if (oppId) {
    const { getJobReport } = await import("@/lib/commercial/reports/jobs");
    await time("getJobReport (one job)", () => getJobReport(oppId, null));
    const { getProjectFinancials } = await import("@/lib/commercial/projects/financials");
    await time("  └ getProjectFinancials", () => getProjectFinancials(oppId));
  }
});
