import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_RETAINAGE_PCT,
  isUsableRetainagePct,
  pickRetainagePct,
} from "@/lib/commercial/aia/constants";
import { stripComments } from "../helpers/strip-comments";

/**
 * The retainage rate is typed ONCE PER JOB.
 *
 * Karan 2026-10-16: "make sure there's an easy way for us to change from 5 to
 * 10 percent." Retainage is a contract term — the GC withholds 5 or 10 of what
 * it has been billed and releases it when its own project closes out — so the
 * rate belongs to the job, not to each certificate.
 *
 * Before this, every application fell back to a hardcoded 5 whenever the form
 * came in blank. On a 10% job that is a trap with no feedback: miss it once
 * and that certificate under-withholds by half, the G702 goes to the GC wrong,
 * and line 5 disagrees with every earlier certificate on the same job.
 */

const app = (
  application_number: number,
  retainage_pct: number,
  is_retainage_release = false,
) => ({ application_number, retainage_pct, is_retainage_release });

describe("pickRetainagePct", () => {
  it("what the operator typed always wins", () => {
    expect(pickRetainagePct({ requested: 10, previous: [app(1, 5)], companyDefault: 7 })).toBe(10);
  });

  it("a typed ZERO wins too — it is a real answer, not a missing one", () => {
    // The `||` bug: 0 is falsy, so a sloppy fallback would silently withhold
    // the company default on a certificate someone deliberately set to 0.
    expect(pickRetainagePct({ requested: 0, previous: [app(1, 5)], companyDefault: 7 })).toBe(0);
  });

  it("carries the rate forward from the job's own last certificate", () => {
    // The whole point: set 10 on App 1, and App 2 is 10 without retyping.
    expect(pickRetainagePct({ previous: [app(1, 10)] })).toBe(10);
    expect(pickRetainagePct({ previous: [app(1, 10), app(2, 10), app(3, 10)] })).toBe(10);
  });

  it("takes the LATEST, not the first, and does not care about input order", () => {
    expect(pickRetainagePct({ previous: [app(3, 8), app(1, 5), app(2, 10)] })).toBe(8);
    expect(pickRetainagePct({ previous: [app(1, 5), app(2, 10), app(3, 8)] })).toBe(8);
  });

  it("NEVER inherits a release's zero — the worst version of this bug", () => {
    // A release runs at 0 and that zero IS the release. Inheriting it would
    // stop withholding entirely from the first release onward, which is
    // exactly the Cipla shape: bill, release, bill again, release again.
    expect(pickRetainagePct({ previous: [app(1, 10), app(2, 0, true)] })).toBe(10);
    expect(
      pickRetainagePct({ previous: [app(1, 10), app(2, 0, true), app(3, 10), app(4, 0, true)] }),
    ).toBe(10);
  });

  it("falls back to the company default on a job's FIRST certificate", () => {
    expect(pickRetainagePct({ previous: [], companyDefault: 10 })).toBe(10);
    expect(pickRetainagePct({ companyDefault: 10 })).toBe(10);
  });

  it("the job beats the company default — a 5% job stays 5% in a 10% company", () => {
    expect(pickRetainagePct({ previous: [app(1, 5)], companyDefault: 10 })).toBe(5);
  });

  it("falls back to the constant when nothing is configured", () => {
    expect(pickRetainagePct({})).toBe(DEFAULT_RETAINAGE_PCT);
    expect(pickRetainagePct({ previous: [], companyDefault: null })).toBe(DEFAULT_RETAINAGE_PCT);
  });

  it("refuses rubbish from the form or a stale row", () => {
    for (const bad of [NaN, Infinity, -1, 101, null, undefined, "10" as unknown as number]) {
      expect(isUsableRetainagePct(bad), String(bad)).toBe(false);
      expect(pickRetainagePct({ requested: bad as number, companyDefault: 10 })).toBe(10);
    }
    // And a corrupt stored rate is skipped rather than carried forward.
    expect(pickRetainagePct({ previous: [app(1, 10), app(2, 999)], companyDefault: 7 })).toBe(10);
  });

  it("0 and 100 are legitimate, so the guard must not be off by one", () => {
    expect(isUsableRetainagePct(0)).toBe(true);
    expect(isUsableRetainagePct(100)).toBe(true);
    expect(pickRetainagePct({ previous: [app(1, 100)] })).toBe(100);
  });

  it("keeps a fractional rate exactly", () => {
    // 7.5% is a real contract term; rounding it to 8 would misbill every line.
    expect(pickRetainagePct({ previous: [app(1, 7.5)] })).toBe(7.5);
  });
});

describe("the settings field is actually wired, end to end", () => {
  const PAGE = "app/commercial/settings/operating-company/page.tsx";
  const src = stripComments(readFileSync(join(process.cwd(), PAGE), "utf8"));

  it("the page is still the operating-company form", () => {
    expect(src.length, `${PAGE} is empty`).toBeGreaterThan(1000);
    expect(src).toContain("updateOperatingCompany(");
  });

  it("the input sits INSIDE the form, not beside it", () => {
    /*
     * The bug this catches is one this repo has shipped before: a control
     * rendered outside its <form> posts nothing, so the page looks right,
     * saving appears to work, and the value never arrives. I made exactly
     * that mistake writing this field — it landed after </form>.
     */
    const open = src.indexOf("<form");
    const close = src.indexOf("</form>");
    expect(open, "no <form> on the page").toBeGreaterThan(-1);
    expect(close, "no </form> on the page").toBeGreaterThan(open);
    const field = src.indexOf('name="default_retainage_pct"');
    expect(field, "the retainage input is gone").toBeGreaterThan(-1);
    expect(field, "the retainage input is OUTSIDE the form — it would post nothing").toBeLessThan(close);
    expect(field).toBeGreaterThan(open);
  });

  it("the action READS the field the form posts", () => {
    // The other half of the same seam: an input nothing reads is just as dead
    // as an input outside the form.
    const action = src.slice(src.indexOf("async function saveAction"), src.indexOf("const Field"));
    expect(action).toContain('get("default_retainage_pct")');
    expect(action, "blank must clear to null, not save 0%").toMatch(/===\s*""\s*\?\s*null/);
  });

  it("reads the stored value back so the box is not always empty", () => {
    expect(src).toContain("getDefaultRetainagePct()");
    expect(src).toContain("defaultRetainagePct");
  });
});

describe("the company default cannot break the rest of Settings", () => {
  const DB = "lib/commercial/operating-company/db.ts";
  const src = stripComments(readFileSync(join(process.cwd(), DB), "utf8"));

  it("is NOT folded into the singleton COLS select", () => {
    /*
     * Migrations here are pasted into Supabase by hand, so there is a window
     * where the column does not exist — and PostgREST answers an unknown
     * column with an error and null data, not a throw. Folding it into COLS
     * would make `getOperatingCompany` return DEFAULTS during that window:
     * wrong company address and wrong signer on every proposal, warranty and
     * G702, with nothing on screen to say why.
     */
    const cols = src.match(/const COLS\s*=\s*\n?\s*"([^"]+)"/);
    expect(cols, "COLS is gone or reshaped").not.toBeNull();
    expect(
      cols![1],
      "default_retainage_pct is in COLS — an un-applied migration now blanks every company setting",
    ).not.toContain("default_retainage_pct");
  });

  it("is read by its own query that tolerates the column being absent", () => {
    const fn = src.slice(src.indexOf("export async function getDefaultRetainagePct"));
    expect(fn).toContain('select("default_retainage_pct")');
    expect(fn, "a PostgREST error must mean 'unset', not a crash").toMatch(/if\s*\(error\)\s*return null/);
  });

  it("refuses an out-of-range default in words", () => {
    const fn = src.slice(src.indexOf("export async function updateOperatingCompany"));
    expect(fn).toMatch(/default_retainage_pct/);
    expect(fn).toMatch(/between 0 and 100/i);
  });
});
