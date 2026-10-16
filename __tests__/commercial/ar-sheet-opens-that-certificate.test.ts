import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AR_APPLICATIONS_SPEC, type ArApplicationRow } from "@/lib/commercial/reports/tomco/ar-applications";
import { stripComments } from "../helpers/strip-comments";

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
 * the column's `href` function is the whole behavior.
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

  it("uses a tab key the job page actually understands", () => {
    // `?tab=…` only works because the job page normalizes it. A tidy-up of
    // the tab keys turns every one of these links into Overview, and nothing
    // in the type system connects the two sides.
    //
    // Two things changed here on 2026-10-16. The read is stripped of
    // comments — `resolveTabParam` is surrounded by prose quoting
    // `?tab=submittals` and `?tab=changeorders`, so an unstripped grep for a
    // tab key could match the documentation of a key the function no longer
    // handles. And the key is no longer hard-coded in the assertion: it is
    // READ OUT OF THE HREF THE SPEC ACTUALLY PRODUCES, so changing the spec
    // to emit `?tab=applications` fails here instead of silently sending
    // every AR line to Overview.
    const href = hrefOf(base)!;
    const key = new URLSearchParams(href.slice(href.indexOf("?"))).get("tab");
    expect(key, "the AR link no longer carries a ?tab= at all").toBeTruthy();

    const page = stripComments(
      readFileSync(join(process.cwd(), "app/commercial/opportunities/[id]/page.tsx"), "utf8")
    );
    const at = page.indexOf("function resolveTabParam");
    expect(at, "resolveTabParam is gone — the whole tab-key contract has moved").toBeGreaterThan(-1);

    // Bounded by the next top-level declaration, NOT by the first `\n}`.
    // `resolveTabParam`'s return type is an inline object spanning three
    // lines, so its closing brace is the first `\n}` in the file after the
    // name — a body slice ending there is 97 characters long, contains the
    // signature and nothing else, and every `raw === "…"` check lives
    // outside it. That window could only ever fail.
    const rest = page.slice(at + 1);
    const nextDecl = rest.search(/^(?:export\s+)?(?:async\s+)?(?:function|const|type|interface)\s/m);
    expect(nextDecl, "no declaration follows resolveTabParam — the slice would run to EOF").toBeGreaterThan(-1);
    const body = page.slice(at, at + 1 + nextDecl);
    expect(body, "the resolveTabParam body came out too short to contain its mapping").toMatch(
      /raw === "overview"/
    );

    expect(
      body,
      `the AR sheet links to ?tab=${key}, which resolveTabParam does not handle — every ` +
        `Application line would land on Overview`
    ).toMatch(new RegExp(`raw === "${key}"`));
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
