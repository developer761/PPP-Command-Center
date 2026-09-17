import { describe, it, expect } from "vitest";

import { AR_APPLICATIONS_SPEC, type ArApplicationRow } from "@/lib/commercial/reports/tomco/ar-applications";

/**
 * Clicking a line on the AR sheet opens THAT certificate.
 *
 * Katie 2026-09-17: "On the AR Sheet - if we click on an invoice, it should
 * open that specific invoice."
 *
 * It did link — to `?tab=project&sub=aia`, the job's AIA tab with nothing
 * selected. So on a job with six certificates you clicked AIA#4 and landed on a
 * list of six, which reads as a broken link rather than a link to the wrong
 * place. The fix is `?tab=aia&app=<uuid>`, which `aia-tool.tsx` turns into the
 * single-certificate view.
 *
 * The href lives in a spec object, not in JSX, so this tests the spec directly:
 * the column's `href` function is the whole behaviour.
 */

const base: ArApplicationRow = {
  id: "11111111-1111-4111-8111-111111111111",
  appId: "11111111-1111-4111-8111-111111111111",
  oppId: "22222222-2222-4222-8222-222222222222",
  jobName: "Somewhere",
  accountName: "A GC",
  label: "AIA#4 · 21/5/26",
  isRetention: false,
  openCents: 125_00,
  notes: null,
  issuedYmd: "2026-05-21",
};

const col = AR_APPLICATIONS_SPEC.columns.find((c) => c.key === "label")!;
const hrefOf = (r: ArApplicationRow) => col.href?.(r) ?? null;

describe("the AR sheet's Application column", () => {
  it("opens the one certificate that was clicked, not the job's list", () => {
    const href = hrefOf(base);
    expect(href).toBe(
      "/commercial/opportunities/22222222-2222-4222-8222-222222222222?tab=aia&app=11111111-1111-4111-8111-111111111111"
    );
    // The bug, stated so this test can fail: a link that stops at the tab.
    expect(href).toContain("app=");
  });

  it("sends a retention line to the certificate it belongs to", () => {
    // Its `id` carries a `:retention` suffix. If the href is ever derived from
    // `id` again, that suffix lands in the URL, fails the tool's UUID test, and
    // the page falls back to the list — the original bug, wearing a new hat.
    const retention: ArApplicationRow = {
      ...base,
      id: `${base.appId}:retention`,
      label: "AIA#4 · 21/5/26 · Retention",
      isRetention: true,
    };
    const href = hrefOf(retention);
    expect(href).toBe(
      "/commercial/opportunities/22222222-2222-4222-8222-222222222222?tab=aia&app=11111111-1111-4111-8111-111111111111"
    );
    expect(href).not.toContain(":retention");
  });

  it("uses a tab key the job page actually understands", async () => {
    // `?tab=aia` only works because the job page normalises it. Pin that, or a
    // tidy-up of the tab keys turns every one of these links into Overview.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("app/commercial/opportunities/[id]/page.tsx", "utf8")
    );
    expect(src).toContain(`if (raw === "aia") return { primary: "project", sub: "aia" };`);
  });

  it("does not link a line Mary typed by hand", () => {
    // Carried-over and manually added lines are not certificates — there is
    // nothing to open, and a link to the job would be a guess. Four of her job
    // names match more than one job here.
    for (const r of [
      { ...base, id: "carryover:3", appId: "", oppId: "", carriedOver: true },
      { ...base, id: "added:1757000000000", appId: "", oppId: "", carriedOver: true },
    ] as ArApplicationRow[]) {
      expect(hrefOf(r)).toBeNull();
    }
  });

  it("does not link a certificate whose job is unknown", () => {
    expect(hrefOf({ ...base, oppId: "" })).toBeNull();
    expect(hrefOf({ ...base, appId: "" })).toBeNull();
  });
});
