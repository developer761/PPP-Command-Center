import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { proposalWentOut, mayCreateRevision } from "@/lib/commercial/proposals/revision-policy";
import { stripComments } from "../helpers/strip-comments";

/**
 * Revisions only after the GC has seen it.
 *
 * Stephanie 2026-08-13: *"do not automatically create a revision every time the
 * proposal is accessed until after the proposal is sent."* Kim works on the
 * original until it goes out; a revision exists because the GC asked for a
 * change, not because someone opened a page.
 */

describe("proposalWentOut", () => {
  it("a fresh draft has not gone out", () => {
    expect(proposalWentOut({ status: "draft", sent_at: null })).toBe(false);
    expect(mayCreateRevision({ status: "draft", sent_at: null })).toBe(false);
  });

  it("a sent proposal has", () => {
    expect(proposalWentOut({ status: "sent", sent_at: "2026-08-13T12:00:00Z" })).toBe(true);
  });

  it("a sent_at stamp counts even if the status was dragged back to draft", () => {
    // It was emailed. The GC has it. Relabelling the row does not un-send it.
    expect(proposalWentOut({ status: "draft", sent_at: "2026-08-01T12:00:00Z" })).toBe(true);
  });

  it("terminal states count, since none is reachable without going out", () => {
    for (const status of ["won", "lost", "superseded", "expired"]) {
      expect(proposalWentOut({ status, sent_at: null })).toBe(true);
    }
  });

  it("a missing parent is not a licence to revise", () => {
    expect(proposalWentOut(null)).toBe(false);
    expect(proposalWentOut(undefined)).toBe(false);
    expect(proposalWentOut({})).toBe(false);
  });
});

describe("the rule is enforced on the route, not just the button", () => {
  const ROUTE = "app/commercial/accounts/[id]/deals/[dealId]/proposal/new/page.tsx";
  const src = stripComments(readFileSync(join(__dirname, "..", "..", ROUTE), "utf8"));

  it("the route file is really there and really this route", () => {
    // Guards the three assertions below. `readFileSync` throws on a missing
    // file, but a renamed-and-reshaped route would still read, and a grep
    // over the wrong file passes or fails for reasons nobody can trace.
    expect(src.length, `${ROUTE} is empty`).toBeGreaterThan(500);
    expect(src, "this is no longer a page component").toMatch(/export default async function/);
  });

  it("/proposal/new IMPORTS the policy rather than re-deciding locally", () => {
    // The seam that matters. Three copies of "has it gone out yet?" is how
    // the button and the route disagreed in the first place; an import is
    // structural and a local re-implementation cannot fake it.
    expect(src).toMatch(
      /import \{[^}]*proposalWentOut[^}]*\} from "@\/lib\/commercial\/proposals\/revision-policy"/
    );
  });

  it("/proposal/new consults the policy before honouring ?bump=", () => {
    // This route MUTATES ON GET. A hidden button is a suggestion; a bookmark,
    // a browser-back or a hand-typed ?bump= is what actually mints a stray R2
    // and splits the work across two rows. If this assertion ever fails, the
    // guard has moved back to being cosmetic.
    expect(src).toContain("proposalWentOut(parent)");
    // And it must land the user on the original rather than erroring.
    expect(src).toContain("?kept=1");
  });

  it("the policy's RESULT is what steers the redirect, not merely computed", () => {
    // A call whose answer is dropped is the shape of `a correct function
    // nobody calls`, one scope smaller: the guard runs, nothing reads it,
    // and the route bumps anyway. Bind it and branch on it.
    const at = src.indexOf("proposalWentOut(parent)");
    expect(at, "guard call not found").toBeGreaterThan(-1);
    const bound = src.slice(Math.max(0, at - 60), at).match(/const (\w+)\s*=\s*$/);
    expect(bound, "the guard's answer is not bound to anything").not.toBeNull();
    const after = src.slice(at, at + 600);
    expect(after, `nothing branches on ${bound?.[1]}`).toMatch(
      new RegExp(`if\\s*\\([^)]*${bound![1]}`)
    );
  });
});

describe("mayCreateRevision has no caller", () => {
  /**
   * STATED, NOT ASSUMED.
   *
   * `mayCreateRevision` is exported, correct, and carries five passing
   * assertions above — and on 2026-10-16 nothing in app/, lib/ or
   * components/ calls it. The route guards itself with `proposalWentOut`
   * directly.
   *
   * Five green assertions against a function production never reaches is
   * exactly the reassurance this suite is being audited for: it reads as
   * "revisions are guarded" and guards nothing. The tests are kept — the
   * function is the clearer expression of the rule and wiring it up is a
   * small change — but the fact is pinned here so the greenness cannot be
   * mistaken for coverage of a shipped path.
   *
   * When somebody does wire it up, this test fails and should be deleted.
   */
  /*
   * THIRTY SECONDS. This parses every file under app/, lib/ and components/
   * to strip comments before grepping — a mention of `mayCreateRevision` in
   * a docblock would read as a caller and turn this green for the wrong
   * reason. At vitest's 5,000 ms default it timed out in a full parallel run
   * on 2026-10-16 and passed alone: a red that tracks how busy the machine
   * is. The budget ends an infinite walk; it does not time a slow one.
   */
  const WHOLE_TREE_WALK_MS = 30_000;

  it("is still uncalled — delete this test on the day that changes", () => {
    const roots = ["app", "lib", "components"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(__dirname, "..", "..", dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name)) {
          const body = stripComments(readFileSync(join(__dirname, "..", "..", rel), "utf8"));
          // `function mayCreateRevision(` is the DECLARATION, not a call —
          // counting it would make this test pass on nothing but itself,
          // which is the failure mode the whole audit is about.
          if (/(?<!function\s)\bmayCreateRevision\s*\(/.test(body)) hits.push(rel);
        }
      }
    };
    roots.forEach(walk);
    expect(
      hits,
      "mayCreateRevision now HAS callers — good. Delete this test and let the " +
        "assertions above stand as real coverage:\n" + hits.join("\n")
    ).toEqual([]);
  }, WHOLE_TREE_WALK_MS);
});
