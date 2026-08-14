import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The drift guard for Kate round-3 #02.
 *
 * Round 2 asked for AM attribution on the progress bar. It was implemented —
 * correctly — in lib/wo-progress/derive.ts. That loader only feeds the Overview
 * page. The materials work-order page, which is the page Kate actually tests,
 * loads through lib/materials-page-data.ts, which never selected
 * created_by_user_id. So the fix looked done in code review and was invisible
 * on screen, and the item came back.
 *
 * Unit-testing buildAttribution cannot catch that: the logic was fine, the CALL
 * was missing. This asserts the wiring instead.
 *
 * These assertions are deliberately narrow. A first version of this file
 * checked `src.includes("buildAttribution")` and `src.includes(
 * "created_by_user_id")` — and it PASSED against a deliberately re-broken
 * loader, because the import line and the type declaration both still mention
 * those names. Anything looser than what's here is decoration.
 */

const LOADERS = ["lib/wo-progress/derive.ts", "lib/materials-page-data.ts"];

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** The column list actually handed to PostgREST for customer_form_tokens. */
function tokenSelect(src: string): string | null {
  const i = src.indexOf('from("customer_form_tokens")');
  if (i === -1) return null;
  const m = /\.select\(\s*(["'`])([\s\S]*?)\1\s*\)/.exec(src.slice(i, i + 1200));
  return m ? m[2] : null;
}

describe("progress loaders stay in step on attribution", () => {
  it.each(LOADERS)("%s asks Salesforce-token rows for created_by_user_id", (rel) => {
    const cols = tokenSelect(read(rel));
    expect(cols, `${rel}: couldn't find the customer_form_tokens select`).not.toBeNull();
    expect(
      cols!.split(",").map((c) => c.trim()),
      `${rel}: without created_by_user_id the bar silently reads "Customer Submitted"`
    ).toContain("created_by_user_id");
  });

  it.each(LOADERS)("%s actually CALLS buildAttribution (an import alone is not wiring)", (rel) => {
    const src = read(rel);
    expect(
      /\bbuildAttribution\s*\(\s*sb\s*,/.test(src),
      `${rel}: must invoke buildAttribution(sb, …), not merely import it`
    ).toBe(true);
  });

  it.each(LOADERS)("%s writes the resolved attribution onto the progress row", (rel) => {
    const src = read(rel);
    expect(
      /const\s+who\s*=\s*attribution\.get\(/.test(src) && /Object\.assign\(\s*\w+\s*,\s*who\s*\)/.test(src),
      `${rel}: resolves attribution but must also assign it onto the progress object`
    ).toBe(true);
  });

  it("neither loader hand-rolls its own profiles name lookup", () => {
    for (const rel of LOADERS) {
      expect(
        /from\(\s*["'`]profiles["'`]\s*\)/.test(read(rel)),
        `${rel}: resolve names via buildAttribution, not a local profiles query — that is how these two drifted apart`
      ).toBe(false);
    }
  });
});
