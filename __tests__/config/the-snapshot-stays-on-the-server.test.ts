/**
 * A "use client" COMPONENT MUST NOT BE HANDED THE SALESFORCE SNAPSHOT.
 *
 * React serializes every prop of a client component into the HTML so it can
 * hydrate. Give one the snapshot and you have put all of Salesforce in the
 * document. Measured against production on 2026-10-16, from a phone:
 *
 *     /dashboard             63.8 MB   12.5 s
 *     /dashboard/financials  63.6 MB   12.0 s
 *     /dashboard/rep         63.7 MB    6.4 s
 *     /dashboard/operations  35.1 MB    4.7 s
 *     /dashboard/map         35.1 MB    3.2 s
 *
 * Time to first byte was ~200ms on all of them. The server was never slow.
 * `quotedSubtotal` appeared 36,885 times in the Overview's HTML and
 * `workOrderNumber` 20,192 times. Alex reads this on his phone every
 * morning, and Karan reported it as "takes like 10 seconds to load".
 *
 * Two things make this worth a test rather than a memory:
 *
 *   1. It is INVISIBLE to every other layer. tsc is happy, the 8,000 unit
 *      tests are pure logic and never render, the build succeeds, and the
 *      page is correct — just enormous. Nothing goes red.
 *
 *   2. The obvious-looking fix does not work. /dashboard/operations and
 *      /dashboard/map already read the THIN snapshot, and both were still
 *      35MB: thin cuts what the server FETCHES, and the cost here is what
 *      the page SENDS. Anyone optimizing this from the server side will
 *      shrink the read and watch the page stay slow.
 *
 * The fix is always the same shape: derive on the server, send the answers.
 * lib/dashboard/*-data.ts does this for all five.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

const ROOTS = ["components", "app"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Commercial + messaging are other sessions' surfaces and are
      // Postgres-native, not snapshot-backed.
      if (entry === "commercial" || entry === "messaging") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strip leading comments — they are legal above the directive. */
function firstStatement(src: string): string {
  let s = src.replace(/^﻿/, "");
  for (;;) {
    const t = s.trimStart();
    if (t.startsWith("//")) { s = t.slice(t.indexOf("\n") + 1); continue; }
    if (t.startsWith("/*")) { s = t.slice(t.indexOf("*/") + 2); continue; }
    return t;
  }
}

function isClientComponent(src: string): boolean {
  return /^["']use client["']/.test(firstStatement(src));
}

/**
 * A prop typed as the whole bundle (`: LiveDashboardBundle`) carries
 * `snapshot`. `Omit<LiveDashboardBundle, "snapshot">` deliberately does not
 * and must keep passing.
 */
const TAKES_WHOLE_BUNDLE = /:\s*LiveDashboardBundle\b/;
const TAKES_SNAPSHOT = /\bSalesforceSnapshot\b/;

/**
 * Known remaining offender. MAY ONLY SHRINK — never add to this list to get
 * a build green.
 *
 *   materials-view.tsx  Still TYPED on the bundle, but no longer carrying a
 *                       real snapshot: lib/materials/view-props.ts strips it
 *                       to `accounts` + `paintColors`, the only two fields
 *                       this component reads. The board comes from
 *                       `openJobsSerialized`. Kept here because the type
 *                       alone cannot distinguish "slimmed" from "full", so
 *                       the slimming is pinned by its own assertions below
 *                       rather than by this list.
 */
const BASELINE = new Set<string>(["components/materials-view.tsx"]);

describe("the Salesforce snapshot does not cross into the browser", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));
  const clientComponents = files.filter((f) => isClientComponent(readFileSync(f, "utf8")));

  it("scanned a real number of client components", () => {
    // A zero-file scan reports a perfect pass forever.
    expect(clientComponents.length).toBeGreaterThan(30);
  });

  it("no client component accepts the whole bundle or a raw snapshot", () => {
    const offenders: string[] = [];
    for (const f of clientComponents) {
      const src = stripComments(readFileSync(f, "utf8"));
      if (TAKES_WHOLE_BUNDLE.test(src) || TAKES_SNAPSHOT.test(src)) offenders.push(f);
    }
    const unexpected = offenders.filter((f) => !BASELINE.has(f));
    expect(
      unexpected,
      "React serializes every prop of a client component into the HTML. A " +
        "component typed on LiveDashboardBundle or SalesforceSnapshot puts " +
        "all of Salesforce in the document — 35-64MB, measured. Derive on " +
        "the server and pass the answers; see lib/dashboard/overview-data.ts:\n" +
        unexpected.join("\n")
    ).toEqual([]);
  });

  it("the baseline may only shrink", () => {
    const stillOffending: string[] = [];
    for (const f of BASELINE) {
      const src = stripComments(readFileSync(f, "utf8"));
      if (TAKES_WHOLE_BUNDLE.test(src) || TAKES_SNAPSHOT.test(src)) stillOffending.push(f);
    }
    expect(
      [...BASELINE].filter((f) => !stillOffending.includes(f)),
      "fixed — delete it from BASELINE so it cannot regress"
    ).toEqual([]);
  });

  it("the five pages fixed on 2026-10-16 derive on the server", () => {
    for (const [page, fn] of [
      ["app/dashboard/page.tsx", "deriveOverviewData"],
      ["app/dashboard/financials/page.tsx", "deriveFinancialsData"],
      ["app/dashboard/operations/page.tsx", "deriveOperationsData"],
      ["app/dashboard/map/page.tsx", "deriveMapData"],
      ["app/dashboard/rep/page.tsx", "deriveRepIndexData"],
    ] as const) {
      const src = stripComments(readFileSync(page, "utf8"));
      expect(src, `${page} stopped deriving server-side`).toContain(fn);
      // And it must not hand the raw bundle straight through again.
      expect(src, `${page} is passing the whole bundle to the client again`)
        .not.toMatch(/bundle=\{bundle\}/);
    }
  });

  it("the Materials hub ships a stripped snapshot, not a real one", () => {
    // The type-level check above cannot see this — materials-view is still
    // declared on LiveDashboardBundle. What matters is what the loader puts
    // IN it. workOrders and woLineItems were the two largest arrays and
    // their only remaining consumer was an admin-only diagnostic panel, so
    // every user paid megabytes on every load for a box they cannot see.
    const props = stripComments(readFileSync("lib/materials/view-props.ts", "utf8"));
    const at = props.indexOf("const slimBundle");
    expect(at, "slimBundle is gone — the snapshot is reaching the browser whole")
      .toBeGreaterThan(-1);
    const slim = props.slice(at, props.indexOf("openJobsSerialized =", at));
    expect(slim.length).toBeGreaterThan(100); // the slice measured something
    for (const field of [
      "workOrders", "woLineItems", "opportunities", "quotes",
      "transactions", "reviews", "cases", "quotas", "subQuotas", "reps",
    ]) {
      expect(slim, `${field} is no longer stripped from the materials payload`)
        .toMatch(new RegExp(`${field}:\\s*\\[\\]`));
    }

    // And the client must not read the stripped fields — doing so would
    // silently render an empty board rather than fail.
    const view = stripComments(readFileSync("components/materials-view.tsx", "utf8"));
    expect(view, "materials-view reads snapshot.workOrders, which is now always empty")
      .not.toMatch(/snapshot[?.]?\.workOrders/);
    expect(view, "materials-view reads snapshot.woLineItems, which is now always empty")
      .not.toMatch(/snapshot[?.]?\.woLineItems/);
    // The diagnostic it used to compute now arrives as a prop.
    expect(view).toContain("snapshotDiagnostic");
  });

  it("DETECTS the shape that shipped — proves the check can fail", () => {
    const shipped = [
      '"use client";',
      'import type { LiveDashboardBundle } from "@/lib/data-source";',
      "type Props = { bundle: LiveDashboardBundle };",
      "export default function V({ bundle }: Props) { return null; }",
    ].join("\n");
    expect(isClientComponent(shipped)).toBe(true);
    expect(TAKES_WHOLE_BUNDLE.test(stripComments(shipped))).toBe(true);

    // And the fixed shape passes.
    const fixed = shipped.replace(
      "bundle: LiveDashboardBundle",
      'bundle: Omit<LiveDashboardBundle, "snapshot">'
    );
    expect(TAKES_WHOLE_BUNDLE.test(stripComments(fixed))).toBe(false);

    // A SERVER component may hold either freely — that is the whole point.
    const server = shipped.replace('"use client";\n', "");
    expect(isClientComponent(server)).toBe(false);
  });
});
