import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Karan, 2026-09-08, on the Hatch messaging rail:
 *
 *  1. "NY should collapse all its workplaces underneath it, same with New
 *     Jersey." 32 workspaces grouped-but-always-expanded still overflow the
 *     rail, so Florida is off-screen while you read New York.
 *
 *  2. "i cant get to the question answering page from the training tab." The
 *     Training page said a decision was needed — conduct or outcome — and
 *     offered nowhere to make it. /messaging/training/import existed and was
 *     reachable only by typing the URL, which is why the whole feature read as
 *     unbuilt.
 *
 * Both are structural rules, so they are asserted against the source rather
 * than a render: what matters is that the escape hatch EXISTS and that the
 * collapse cannot swallow the active workspace.
 */
const ROOT = join(__dirname, "..", "..");
const sidebar = readFileSync(join(ROOT, "components/messaging/messaging-sidebar.tsx"), "utf8");
const training = readFileSync(join(ROOT, "app/messaging/training/page.tsx"), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("region groups collapse", () => {
  it("the header toggles, and says so to a screen reader", () => {
    expect(code(sidebar)).toMatch(/onClick=\{\(\) => toggleRegion\(region\)\}/);
    expect(code(sidebar)).toMatch(/aria-expanded=\{open\}/);
  });

  it("the workspace list only renders when the group is open", () => {
    expect(code(sidebar)).toMatch(/\{open && list\.map\(/);
  });

  it("a group holding the ACTIVE workspace can never be collapsed", () => {
    // Otherwise a deep link lands you on a page whose nav entry is hidden.
    expect(code(sidebar)).toMatch(/if \(list\.some\(\(w\) => w\.id === activeWs\)\) return true;/);
  });

  it("the open/closed set survives navigation", () => {
    expect(code(sidebar)).toMatch(/localStorage\.getItem\(COLLAPSE_KEY\)/);
    expect(code(sidebar)).toMatch(/localStorage\.setItem\(COLLAPSE_KEY/);
  });

  it("localStorage failures do not break the rail", () => {
    // Private browsing throws on setItem; a nav that crashes there is worse
    // than one that forgets.
    const body = code(sidebar);
    expect(body).toMatch(/try \{[\s\S]*?localStorage\.setItem[\s\S]*?\} catch/);
    expect(body).toMatch(/try \{[\s\S]*?localStorage\.getItem[\s\S]*?\} catch/);
  });

  it("collapsed groups still show how much is hidden", () => {
    expect(code(sidebar)).toMatch(/\{!open && \(/);
  });
});

describe("the Training page can reach the import screen", () => {
  it("links there while the corpus is empty — where the question is asked", () => {
    expect(code(training)).toMatch(/href="\/messaging\/training\/import"/);
  });

  it("keeps a way in AFTER rows exist", () => {
    // The blocker card disappears at total > 0; the entry point must not.
    const body = code(training);
    const links = body.match(/href="\/messaging\/training\/import"/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/s\.total > 0 &&/);
  });

  it("the import screen actually asks the conduct-vs-outcome question", () => {
    const form = readFileSync(join(ROOT, "components/messaging/training-import-form.tsx"), "utf8");
    expect(form).toMatch(/How well it was handled/);
    expect(form).toMatch(/Whether it booked/);
  });
});
