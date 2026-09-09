import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Two mobile rules that are invisible on a laptop and obvious on a phone.
 *
 * ZOOM. iOS Safari zooms the whole viewport when a focused field's font-size is
 * under 16px, and does not zoom back out. The page is then wider than the
 * screen and everything below is off to the right. Eighteen fields were doing
 * this, including the SIGN-IN FORM — the first thing anyone touches.
 *
 * TAP. Apple's own minimum is 44x44. Below that a control is hit-or-miss with a
 * thumb, and the crew is on phones on a job site.
 *
 * Both are asserted by PARSING the tag, not by grepping. The first version of
 * this audit used a regex that stopped at the first ">" — which meant any
 * control with an `onChange={(e) => …}` handler was skipped entirely, because
 * the arrow contains one. It reported 4 zoom problems; there were 18. The tag
 * scanner below tracks brace depth and ignores "=>" for exactly that reason.
 */
const ROOT = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", "worktrees"].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Residential only — Commercial is a separate platform with its own session. */
const FILES = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))].filter(
  (f) => !f.includes("/commercial") && !f.includes("commercial-")
);

/** End of the opening tag, ignoring ">" inside {...} and inside "=>". */
function tagEnd(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[j - 1] !== "=") return j;
  }
  return src.length;
}

function classesOf(src: string, tags: string) {
  const out: Array<{ cls: string; line: number; tag: string }> = [];
  for (const m of src.matchAll(new RegExp(`<(${tags})\\b`, "g"))) {
    const i = m.index!;
    const attrs = src.slice(i, tagEnd(src, i));
    const cm = attrs.match(/className=(?:\{`|")([^"`]*?)(?:`\}|")/);
    if (cm) out.push({ cls: cm[1], line: src.slice(0, i).split("\n").length, tag: m[1] });
  }
  return out;
}

const SMALL = /(?<!sm:)(?<!md:)(?<!lg:)\btext-(xs|sm|\[(?:[0-9]|1[0-5])(?:\.\d+)?px\])/;

function bigEnough(cls: string): boolean {
  for (const [, n] of cls.matchAll(/min-h-\[(\d+)px\]/g)) if (+n >= 44) return true;
  for (const [, n] of cls.matchAll(/\bh-(\d+)\b/g)) if (+n * 4 >= 44) return true;
  for (const [, n] of cls.matchAll(/\bpy-(\d+(?:\.\d+)?)\b/g)) if (+n * 8 + 20 >= 44) return true;
  if (cls.includes("w-full") && /\bpy-(3|4|5|6)\b/.test(cls)) return true;
  return false;
}

describe("the tag scanner can see what a naive regex misses", () => {
  it("reads className past an arrow-function handler", () => {
    // The bug that made the first audit under-report by 4x.
    const s = `<select onChange={(e) => f(e)} className="text-[10px]">`;
    expect(classesOf(s, "select")[0]?.cls).toBe("text-[10px]");
  });

  it("sizes are judged, not pattern-matched", () => {
    expect(bigEnough("min-h-[56px]")).toBe(true);   // bigger than 44 still passes
    expect(bigEnough("h-11 w-11")).toBe(true);
    expect(bigEnough("h-8 w-8")).toBe(false);
    expect(bigEnough("px-2 py-0.5")).toBe(false);
  });
});

describe("no field zooms the page on iOS", () => {
  it("every input, select and textarea is 16px at mobile", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const { cls, line, tag } of classesOf(readFileSync(f, "utf8"), "input|select|textarea")) {
        if (cls.includes("text-base")) continue;
        if (SMALL.test(cls)) bad.push(`${f.replace(ROOT + "/", "")}:${line} <${tag}>`);
      }
    }
    expect(bad, "under 16px — iOS will zoom and not zoom back").toEqual([]);
  });
});

describe("controls are thumb-sized on a phone", () => {
  it("no button or select is under 44px", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const { cls, line, tag } of classesOf(readFileSync(f, "utf8"), "button|select")) {
        if (bigEnough(cls)) continue;
        // Bare text links inside prose are not controls.
        if (!/rounded|border|bg-|px-|h-/.test(cls)) continue;
        bad.push(`${f.replace(ROOT + "/", "")}:${line} <${tag}>`);
      }
    }
    expect(bad, "under Apple's 44px minimum").toEqual([]);
  });
});
