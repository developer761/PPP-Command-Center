import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A SOURCE GREP MUST NOT READ COMMENTS.
 *
 * Several hundred tests in this suite `readFileSync` a source file and then
 * assert something about the text. That is a legitimate technique — it is how
 * a DB-free suite checks a seam — but it has one failure mode that turns the
 * test into a lie: the string being matched can live in a COMMENT, and a
 * comment is not behaviour.
 *
 * The cost, measured in this repo:
 *
 *   - A test asserting two guard sentences appear in `lib/commercial/aia/db.ts`
 *     stayed GREEN after both guard blocks were DELETED. The sentences
 *     survived in a comment. 30 of 30 passed.
 *   - A deduct-alternate suite, fifteen assertions, every one a regex over
 *     source, shipped green while the money path was wrong by $343,505.52.
 *   - `__tests__/helpers/strip-comments.ts`'s own docblock lists five more.
 *
 * `stripComments` exists for exactly this. This file makes using it the rule
 * rather than the convention, by PARSING every test — grepping the tests for
 * the pattern would be the same mistake one level up.
 *
 * It bans two shapes:
 *
 *   UNSTRIPPED  a readFileSync on a .ts/.tsx/.js path whose result reaches a
 *               `.toContain` / `.toMatch` / `.includes` / `.indexOf` /
 *               `regex.test()` with no `stripComments` in between.
 *
 *   PRIVATE     a hand-rolled comment stripper — `.replace(/\/\*…*␀/\/g, "")`
 *               and friends — applied instead of the shared helper. The
 *               helper's docblock says why it is deliberately the only copy,
 *               and 2026-10-16 proved it twice: one private copy carried a
 *               `(^|[^:])` patch to stop it eating `https://`, a symptom of a
 *               general bug the shared helper has now actually fixed; 98 test
 *               files carried a copy that ate every URL in the file silently.
 *               Two spellings of one regex drifting apart is the next version
 *               of this bug.
 */

const ROOT = join(__dirname, "..", "..");

/**
 * Files allowed to grep source WITHOUT stripping comments, and why.
 *
 * Every entry is a decision somebody made on purpose. The test below also
 * checks each one is still doing the thing it is excused for, so an entry
 * cannot outlive its reason — a stale exemption is how an allowlist turns
 * into a blanket.
 */
const ALLOWED = new Map<string, string>([
  [
    "__tests__/commercial/aia-tax-is-in-the-contract-price.test.ts",
    "Asserts the COMMENT itself. Stephanie accepted a known trade-off — tax " +
      "folded into the contract price makes the Original Contract Sum move " +
      "when an exemption certificate lands mid-job — and the deliverable is " +
      "that the next person reads why before 'fixing' it. The same test also " +
      "asserts the sentence is NOT in the stripped source, i.e. that the " +
      "explanation is still prose and has not decayed into a string literal.",
  ],
  [
    "__tests__/messaging/simulator-parity.test.ts",
    "Needs both readings of lib/messaging/simulator.ts and keeps them apart: " +
      "code() is stripped and must NOT claim the carrier answers HELP, raw() " +
      "is unstripped and must still carry the comment explaining why that " +
      "claim was wrong. Strip raw() and the two assertions collapse into one.",
  ],
]);

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

/** The text of a `.replace()` argument that is trying to remove comments. */
const PRIVATE_STRIPPER = /\\\/\\\*|\\\/\\\//;

const GREP_MATCHERS = new Set(["toContain", "toMatch"]);
const GREP_METHODS = new Set(["includes", "indexOf", "lastIndexOf", "match", "matchAll", "search"]);

export type Offence = { line: number; kind: "UNSTRIPPED" | "PRIVATE"; detail: string };

function analyse(fileName: string, text: string): Offence[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  type Info = { stripped: boolean; private: boolean; path: string };

  const varInfo = new Map<string, Info>();
  const fnInfo = new Map<string, Info>();
  const offences: Offence[] = [];

  const literalsIn = (n: ts.Node): string[] => {
    const out: string[] = [];
    const rec = (x: ts.Node) => {
      if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) out.push(x.text);
      ts.forEachChild(x, rec);
    };
    rec(n);
    return out;
  };

  /** Does this readFileSync name a SOURCE file? A dynamic path counts. */
  const readsSource = (call: ts.CallExpression): string | null => {
    const strs = literalsIn(call).filter((s) => /\.[a-z0-9]+$/i.test(s) && s !== "utf8");
    if (strs.length === 0) return "<dynamic>";
    return strs.some((s) => SOURCE_EXT.test(s)) ? strs.join("|") : null;
  };

  /** Non-null when `expr` derives from a readFileSync. */
  function trace(expr: ts.Node): Info | null {
    if (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr)) return trace(expr.expression);
    if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return trace(expr.expression);

    if (ts.isIdentifier(expr)) return varInfo.get(expr.text) ?? null;

    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";

      if (name === "readFileSync") {
        const path = readsSource(expr);
        return path ? { stripped: false, private: false, path } : null;
      }
      if (name === "stripComments") {
        const inner = expr.arguments[0] ? trace(expr.arguments[0]) : null;
        return { stripped: true, private: false, path: inner?.path ?? "?" };
      }
      // A helper declared in this file: `const read = (p) => readFileSync(...)`
      if (ts.isIdentifier(callee) && fnInfo.has(callee.text)) return fnInfo.get(callee.text)!;

      if (ts.isPropertyAccessExpression(callee)) {
        // `await import("node:fs").then((fs) => fs.readFileSync(...))`
        if (name === "then") {
          const cb = expr.arguments[0];
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
            const body = ts.isBlock(cb.body) ? firstReturn(cb.body) : cb.body;
            if (body) return trace(body);
          }
        }
        const base = trace(callee.expression);
        if (base) {
          if (name === "replace" && PRIVATE_STRIPPER.test(expr.arguments[0]?.getText(sf) ?? ""))
            return { ...base, private: !base.stripped };
          return base; // .slice / .trim / .toLowerCase / … keep the taint
        }
      }
      return null;
    }

    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr))
      return trace(expr.expression);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return trace(expr.left) ?? trace(expr.right);
    if (ts.isConditionalExpression(expr)) return trace(expr.whenTrue) ?? trace(expr.whenFalse);
    return null;
  }

  function firstReturn(b: ts.Block): ts.Expression | undefined {
    let found: ts.Expression | undefined;
    const v = (n: ts.Node) => {
      if (found) return;
      if (ts.isReturnStatement(n) && n.expression) found = n.expression;
      else ts.forEachChild(n, v);
    };
    v(b);
    return found;
  }

  // Bindings first — three passes so declaration order does not matter.
  for (let pass = 0; pass < 3; pass++) {
    const bind = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = n.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const body = ts.isBlock(init.body) ? firstReturn(init.body) : init.body;
          const info = body ? trace(body) : null;
          if (info) fnInfo.set(n.name.text, info);
        } else {
          const info = trace(init);
          if (info) varInfo.set(n.name.text, info);
        }
      }
      if (ts.isFunctionDeclaration(n) && n.name && n.body) {
        const r = firstReturn(n.body);
        const info = r ? trace(r) : null;
        if (info) fnInfo.set(n.name.text, info);
      }
      ts.forEachChild(n, bind);
    };
    bind(sf);
  }

  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const flag = (n: ts.Node, info: Info | null, how: string) => {
    if (!info) return;
    if (info.private) offences.push({ line: lineOf(n), kind: "PRIVATE", detail: `${how} on ${info.path}` });
    else if (!info.stripped)
      offences.push({ line: lineOf(n), kind: "UNSTRIPPED", detail: `${how} on ${info.path}` });
  };

  const unwrapExpect = (e: ts.Expression): ts.Expression | undefined => {
    let cur: ts.Expression = e;
    while (ts.isPropertyAccessExpression(cur)) cur = cur.expression; // .not, .resolves
    if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === "expect")
      return cur.arguments[0];
    return undefined;
  };

  const scan = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text;
      if (GREP_MATCHERS.has(m)) {
        const subject = unwrapExpect(n.expression.expression);
        if (subject) flag(n, trace(subject), `expect().${m}()`);
      }
      if (GREP_METHODS.has(m)) flag(n, trace(n.expression.expression), `.${m}()`);
      if (m === "test" && n.arguments[0]) flag(n, trace(n.arguments[0]), "regex.test()");
    }
    ts.forEachChild(n, scan);
  };
  scan(sf);

  return offences;
}

// ---------------------------------------------------------------------------
// Prove the checker can fail, before trusting what it says about 600 files
// ---------------------------------------------------------------------------

describe("the checker itself", () => {
  const BAD = [
    [
      "a bare read then toContain",
      `const src = readFileSync("lib/x.ts", "utf8");
       expect(src).toContain("thing");`,
    ],
    [
      "a read through a local helper",
      `const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
       expect(read("lib/x.ts")).toMatch(/thing/);`,
    ],
    [
      "a slice of an unstripped read",
      `const src = readFileSync("lib/x.ts", "utf8");
       const win = src.slice(src.indexOf("a"), 40);
       expect(win).toContain("thing");`,
    ],
    [
      "a regex tested against an unstripped read",
      `const src = readFileSync("lib/x.ts", "utf8");
       expect(/thing/.test(src)).toBe(true);`,
    ],
    [
      "the fs-via-dynamic-import spelling",
      `const src = await import("node:fs").then((fs) => fs.readFileSync("lib/x.ts", "utf8"));
       expect(src).toContain("thing");`,
    ],
    [
      "a private comment stripper instead of the helper",
      `const src = readFileSync("lib/x.ts", "utf8")
         .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")
         .replace(/^\\s*\\/\\/.*$/gm, "");
       expect(src).toContain("thing");`,
    ],
  ] as const;

  for (const [label, code] of BAD) {
    it(`flags ${label}`, () => {
      expect(analyse("t.test.ts", code).length, code).toBeGreaterThan(0);
    });
  }

  const GOOD = [
    [
      "a stripped read",
      `const src = stripComments(readFileSync("lib/x.ts", "utf8"));
       expect(src).toContain("thing");`,
    ],
    [
      "a stripped read through a helper",
      `const read = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"));
       expect(read("lib/x.ts")).toMatch(/thing/);
       expect(read("lib/x.ts").slice(0, 20)).toContain("thing");`,
    ],
    [
      "a non-source file, where comments are not a concept we handle",
      `const sql = readFileSync("supabase/migrations/001_x.sql", "utf8");
       expect(sql).toContain("create table");`,
    ],
    [
      "a value that never came from a file",
      `const s = renderThing();
       expect(s).toContain("thing");`,
    ],
  ] as const;

  for (const [label, code] of GOOD) {
    it(`passes ${label}`, () => {
      expect(analyse("t.test.ts", code), code).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

function allTests(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.test\.tsx?$/.test(e.name)) out.push(rel);
    }
  };
  walk("__tests__");
  return out;
}

describe("every source grep strips comments first", () => {
  const files = allTests();
  const found = new Map<string, Offence[]>();
  for (const f of files) {
    const hits = analyse(f, readFileSync(join(ROOT, f), "utf8"));
    if (hits.length) found.set(f, hits);
  }

  it("scanned the whole suite, not an empty list", () => {
    // An audit that measured nothing reports a clean bill of health. This
    // suite has ~600 test files; a count in the single digits means the walk
    // broke, not that the problem went away.
    expect(files.length).toBeGreaterThan(400);
  });

  it("the checker still finds the shapes it is looking for", () => {
    // Paired with the count above: if `analyse` silently stopped matching —
    // a TypeScript API change, a renamed matcher — every file would come
    // back clean and this file would become decoration. The allowlisted
    // files are known offenders, so at least that many must be detected.
    const detected = [...ALLOWED.keys()].filter((f) => found.has(f));
    expect(
      detected.sort(),
      "the checker no longer detects its own known offenders — it has stopped working"
    ).toEqual([...ALLOWED.keys()].sort());
  });

  it("no test greps source without stripComments", () => {
    const offenders = [...found.entries()]
      .filter(([f]) => !ALLOWED.has(f))
      .map(([f, hits]) => `${f}\n` + hits.map((h) => `    ${h.kind} line ${h.line}: ${h.detail}`).join("\n"));

    expect(
      offenders,
      "These read a source file and match against the text without removing comments first.\n" +
        "A comment is not behaviour: a test like this passes on a docblock that mentions the\n" +
        "thing, long after the thing itself is gone.\n\n" +
        "Fix: wrap the read — `stripComments(readFileSync(p, \"utf8\"))`, importing from\n" +
        "__tests__/helpers/strip-comments. Better still, where the behaviour is reachable\n" +
        "without a database, assert on a real value instead of on source text.\n\n" +
        "If matching the comment IS the point, add the file to ALLOWED in\n" +
        "__tests__/config/source-greps-strip-comments.test.ts with a reason.\n\n" +
        offenders.join("\n\n")
    ).toEqual([]);
  });

  it("every allowlist entry is still earning its place", () => {
    // A reason that has stopped being true is worse than no allowlist: it
    // exempts a file nobody is thinking about any more.
    const stale = [...ALLOWED.keys()].filter((f) => !found.has(f));
    expect(
      stale,
      "these no longer grep source unstripped — delete them from ALLOWED:\n" + stale.join("\n")
    ).toEqual([]);
  });

  it("every allowlist entry says WHY, at length", () => {
    for (const [file, reason] of ALLOWED) {
      expect(reason.length, `${file}'s exemption needs a real reason, not a label`).toBeGreaterThan(80);
    }
  });

  it("every allowlisted file exists", () => {
    for (const f of ALLOWED.keys()) {
      expect(files, `${f} is allowlisted but is not a test file any more`).toContain(f);
    }
  });
});

void relative; // kept for diagnostics while editing this file
