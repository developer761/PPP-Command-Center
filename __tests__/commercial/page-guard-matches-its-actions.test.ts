import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
  { re: /\brequireCrewOrStaff\s*\(/, level: 1 },
  { re: /\brequireReportAccess\s*\(/, level: 2 },
  { re: /\brequireFinanceViewer\s*\(/, level: 3 },
  { re: /\brequireEditor\s*\(/, level: 3 },
  { re: /\b(requireAdmin|guardAdmin|requireSettingsAdmin)\s*\(/, level: 4 },
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

/** Every page.tsx under app/commercial. */
function pages(dir = ROOT, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) pages(p, out);
    else if (e.name === "page.tsx") out.push(p);
  }
  return out;
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
  const re = /async function (\w+)\s*\([^)]*\)\s*\{\s*"use server";/g;
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

  it("found the commercial pages at all", () => {
    // A zero-file scan would pass every assertion below.
    expect(files.length).toBeGreaterThan(50);
  });

  it("every action calls a gate at least as strong as its page", () => {
    const problems: string[] = [];
    let actionsChecked = 0;

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const actions = serverActionBodies(src);
      if (actions.length === 0) continue;

      // The page's own gate: the level of the file MINUS the action bodies,
      // so a strong action cannot vouch for a weak page.
      let pageSrc = src;
      for (const a of actions) pageSrc = pageSrc.replace(a.body, "");
      const helpers = localHelperLevels(src);
      const pageLevel = gateLevel(pageSrc, helpers);
      if (pageLevel === 0) continue; // ungated page — nothing to be weaker than

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

    expect(actionsChecked, "no server actions were scanned — the parser has drifted").toBeGreaterThan(20);
    expect(problems.join("\n")).toBe("");
  });
});
