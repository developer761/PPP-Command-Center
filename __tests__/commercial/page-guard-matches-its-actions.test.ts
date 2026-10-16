import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * A page's server ACTIONS must be gated at least as strongly as the page.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * `app/commercial/accounting/page.tsx` renders behind `requireFinanceViewer()`
 * — admin or account manager, because the page shows the company's money. All
 * TEN of its server actions authenticated with `assertCommercialAccess` alone,
 * which only asks "do you have commercial access at all".
 *
 * `lib/commercial/auth.ts` states the consequence in its own docblock: a
 * server action POSTs to the page path and executes even when the render-time
 * redirect would have fired, and action ids are build-global. So a rep could
 * record customer payments, edit AR rows, tick bank deposits, email the
 * receivables sheet — and cost and POST an entire payroll week onto every job
 * — on a page they cannot open, while being unable to approve a single hour.
 *
 * Nothing could see it. Types cannot; the unit suite has no HTTP; the smoke
 * test renders pages and never posts. Forty-plus commercial test files and not
 * one asserted this parity.
 *
 * ── WHAT IS CHECKED ────────────────────────────────────────────────────────
 *
 * For every `app/commercial/**\/page.tsx`: find the gate the page itself calls,
 * and require every `"use server"` function in the same file to call a gate at
 * least as strong. Strength is a deliberate ladder, not a guess — see GATES.
 *
 * ── WHAT IT USED TO MISS (audit 2026-10-16) ───────────────────────────────
 *
 * It walked only `page.tsx`, so the 33 actions in the `*-tool.tsx` delivery
 * tools (AIA, close-out, change orders, costs, work order, submittals — where
 * most of the money is) and the 7 in `reports/folder-actions.ts` were never
 * looked at. It skipped any page with no gate of its own, which was 21 actions
 * including every invoice-payment and bulk-delete one. And its floors (>20
 * actions, >50 files) sat so far under the real numbers that a parser drift
 * halving coverage would have stayed green. Now:
 *   - every `.ts`/`.tsx` under app/commercial is read, file-level
 *     `"use server"` modules included;
 *   - a component file is held to the strongest page that imports it;
 *   - nothing under app/commercial counts as level 0 — the floor there is
 *     "has Commercial access at all", which is what the layout promises;
 *   - the floors are pinned near the measured totals.
 */

const ROOT = "app/commercial";

/**
 * The gate ladder, weakest to strongest. A page gated at level N needs its
 * actions at level N or above.
 *
 * `requireAdmin` / `guardAdmin` / `requireSettingsAdmin` are local helpers in
 * several page files; they all resolve to an admin check.
 */
const GATES: { re: RegExp; level: number }[] = [
  { re: /\bassertCommercialAccess\s*\(/, level: 1 },
  // assertCommercialAccess plus the session lookup; what the tools call.
  { re: /\brequireCommercialUser\s*\(/, level: 1 },
  { re: /\brequireCrewOrStaff\s*\(/, level: 1 },
  { re: /\brequireReportAccess\s*\(/, level: 2 },
  { re: /\brequireFinanceViewer\s*\(/, level: 3 },
  { re: /\brequireEditor\s*\(/, level: 3 },
  { re: /\b(requireAdmin|guardAdmin|requireSettingsAdmin)\s*\(/, level: 4 },
  // An inline role check that bounces a non-admin (settings/repairs' own
  // requireAdminUser). Only the bounce counts — reading the role is not a gate.
  { re: /\bif\s*\(\s*\w*role\s*!==\s*["']admin["']\s*\)\s*(redirect|notFound)\s*\(/, level: 4 },
];

function directGateLevel(src: string): number {
  let best = 0;
  for (const g of GATES) if (g.re.test(src)) best = Math.max(best, g.level);
  return best;
}

/**
 * Local gate helpers, resolved rather than guessed.
 *
 * Most pages wrap their check in a file-local `requireAccessAdmin()` /
 * `guardOrRedirect()` and call that. Hard-coding a list of blessed names made
 * the first version of this test report thirteen false failures — and a test
 * that cries wolf gets muted, which is worse than not having it. So the
 * helper's OWN body is read, and calling it counts for whatever it calls.
 */
function localHelperLevels(src: string): Map<string, number> {
  const bodies = new Map<string, string>();
  const out = new Map<string, number>();
  // Match only up to the closing paren; the BODY brace is found by scanning,
  // because a return type like `Promise<{ id: string }>` contains braces of
  // its own. Matching `\{` straight after the paren landed inside that type
  // and balanced to the end of the TYPE, so `esignActor` looked ungated.
  const re = /(?:async\s+)?function\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Walk past the parameter list, then past any return type, to the brace
    // that opens the body — tracking angle depth so `Promise<{…}>` is skipped.
    let j = m.index + m[0].length;
    let paren = 1;
    while (j < src.length && paren > 0) {
      if (src[j] === "(") paren++;
      else if (src[j] === ")") paren--;
      j++;
    }
    let angle = 0;
    while (j < src.length) {
      const c = src[j];
      if (c === "<") angle++;
      else if (c === ">") angle--;
      else if (c === "{" && angle <= 0) break;
      else if (c === ";" && angle <= 0) break; // a declaration with no body
      j++;
    }
    if (src[j] !== "{") continue;
    const start = j + 1;
    // Balance braces to the end of this function.
    let depth = 1, i = start;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const body = src.slice(start, i);
    bodies.set(m[1], body);
    const lvl = directGateLevel(body);
    if (lvl > 0) out.set(m[1], lvl);
  }
  /**
   * TRANSITIVELY. A helper often calls another helper: the proposal page has
   * `esignActor()` → `requireAuthed()` → `assertCommercialAccess()`. Resolving
   * one hop reported those actions as ungated, which they are not. Iterate to
   * a fixed point instead of assuming a depth.
   */
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const [name, body] of bodies) {
      let best = out.get(name) ?? 0;
      for (const [other, lvl] of out) {
        if (other !== name && new RegExp(`\\b${other}\\s*\\(`).test(body)) best = Math.max(best, lvl);
      }
      if (best > (out.get(name) ?? 0)) {
        out.set(name, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

function gateLevel(src: string, helpers: Map<string, number>): number {
  let best = directGateLevel(src);
  for (const [name, lvl] of helpers) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(src)) best = Math.max(best, lvl);
  }
  return best;
}

/** Every .ts / .tsx under app/commercial — pages, tools and action modules. */
function pages(dir = ROOT, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) pages(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Does `src` import the module at `file` (by relative or @/ path)? */
function importsFile(src: string, importer: string, file: string): boolean {
  const target = file.replace(/\.tsx?$/, "");
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const spec = m[1] ?? m[2];
    const resolved = spec.startsWith("@/")
      ? spec.slice(2)
      : spec.startsWith(".")
        ? join(dirname(importer), spec)
        : null;
    if (resolved && resolved.replace(/\.tsx?$/, "") === target) return true;
  }
  return false;
}

/**
 * The bodies of every `"use server"` function in a file.
 *
 * Deliberately crude: from each `"use server"` marker to the next top-level
 * `async function` / `export` boundary. It only has to be good enough to see
 * which gate is called inside, and erring long would HIDE a missing gate — so
 * it stops at the next function declaration.
 */
function serverActionBodies(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  // A module whose FIRST statement is "use server" makes every exported async
  // function an action, with no per-function marker to find.
  const re = /^\s*["']use server["'];?/.test(src)
    ? /export async function (\w+)\s*\([^)]*\)[^{]*\{/g
    // The optional `: Promise<{ ok: boolean }>` return type was not allowed for,
    // which hid aia-tool's saveSettingsAutosaveAction. Tempered so the span
    // cannot run on into the next function.
    : /async function (\w+)\s*\([^)]*\)(?:\s*:(?:(?!function)[^"=])*?)?\s*\{\s*"use server";/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    const next = src.slice(start + m[0].length).search(/\nasync function |\nexport (async )?function |\nfunction /);
    const body = next === -1 ? src.slice(start) : src.slice(start, start + m[0].length + next);
    out.push({ name: m[1], body });
  }
  return out;
}

describe("a page's server actions are gated as strongly as the page", () => {
  const files = pages();
  const sources = new Map(files.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));

  /** A file's own gate: its level MINUS its action bodies. */
  function ownLevel(file: string): number {
    const src = sources.get(file)!;
    let rest = src;
    for (const a of serverActionBodies(src)) rest = rest.replace(a.body, "");
    return gateLevel(rest, localHelperLevels(src));
  }

  /** The level a file's actions must meet: its own, or its strongest importer's. */
  function requiredLevel(file: string): number {
    let best = ownLevel(file);
    if (!file.endsWith("page.tsx")) {
      for (const [other, src] of sources) {
        if (other !== file && other.endsWith("page.tsx") && importsFile(src, other, file)) {
          best = Math.max(best, ownLevel(other));
        }
      }
    }
    // The commercial layout already requires Commercial access to render
    // anything here, so no action under it may ask for less.
    return Math.max(best, 1);
  }

  it("found the commercial pages at all", () => {
    // A zero-file scan would pass every assertion below. Measured 2026-10-16:
    // 90 page.tsx, 140 files in all.
    expect(files.filter((f) => f.endsWith("page.tsx")).length).toBeGreaterThan(85);
    expect(files.length).toBeGreaterThan(130);
  });

  it("every action calls a gate at least as strong as its page", () => {
    const problems: string[] = [];
    let actionsChecked = 0;

    const nonPage: string[] = [];
    for (const file of files) {
      const src = sources.get(file)!;
      const actions = serverActionBodies(src);
      if (actions.length === 0) continue;
      if (!file.endsWith("page.tsx")) nonPage.push(file);

      // The page's own gate is the file MINUS the action bodies, so a strong
      // action cannot vouch for a weak page.
      const helpers = localHelperLevels(src);
      const pageLevel = requiredLevel(file);

      for (const a of actions) {
        actionsChecked += 1;
        const lvl = gateLevel(a.body, helpers);
        if (lvl < pageLevel) {
          problems.push(
            `${file} → ${a.name}() is gated at level ${lvl}, but the page requires level ${pageLevel}. ` +
              `A server action POSTs to the page path and runs even when the page's redirect would have fired.`,
          );
        }
      }
    }

    // Measured 2026-10-16: 7 non-page action files (6 tools + folder-actions)
    // and 220+ actions. Pinned close, so a parser drift that loses a slice of
    // them goes red instead of passing over less.
    expect(nonPage.length, "the *-tool.tsx / action-module files were not scanned").toBeGreaterThanOrEqual(7);
    expect(actionsChecked, "server actions went unscanned — the parser has drifted").toBeGreaterThan(200);
    expect(problems.join("\n")).toBe("");
  });
});
