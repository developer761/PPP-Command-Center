import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * Nothing you tap on a phone may be smaller than 44px.
 *
 * Alex opens this on his phone every morning, and 44px is the floor the
 * platform already committed to — most controls carry `min-h-[44px]`. The fix
 * pattern is the platform's own: full target on mobile, tighter rhythm from
 * `sm:` up — `min-h-[44px] sm:min-h-[36px]` — because a 36px icon button in a
 * dense desktop toolbar looks broken, and a 36px one on a phone IS broken.
 *
 * A tap target cannot be checked by rendering, and nobody re-measures by hand.
 *
 * ─── WHAT THIS USED TO MISS, AND WHY (2026-10-16) ──────────────────────────
 *
 * The first version of this file found SIX offenders. It was reading past 62.
 * Three separate blind spots, each of which made the guard quieter rather than
 * louder, so the green run read as "the platform is fine":
 *
 *  1. `min-h-[Npx]` was never PARSED, only string-matched against the literal
 *     `min-h-[44px]`. So `min-h-[24px]` — fourteen undo / dismiss / "view all"
 *     links across accounts, invoices and opportunities, a 24px target on a
 *     phone — did not merely pass, it was treated as an explicit EXEMPTION
 *     from the h-N check beneath it. The smaller the number somebody wrote,
 *     the more thoroughly it was ignored.
 *
 *  2. The element matcher was `<button[^>]{0,900}?className="..."`. `[^>]`
 *     stops at the first `>` — and `onClick={() => …}` contains one. Any
 *     control with an inline arrow handler before its className (most of
 *     them) was invisible.
 *
 *  3. Only `className="…"` was read. ``className={`… ${active ? … : …}`}`` —
 *     the spelling used by every toggle and segmented control on the
 *     platform — was invisible too.
 *
 * So the tag is now walked with a brace/quote-aware scanner to its real `>`,
 * every string INSIDE the className expression is collected (template chunks
 * and both ternary branches), and heights are parsed as numbers.
 *
 * Interpolation holes are replaced with a space, never dropped, so classes
 * either side of a `${}` cannot fuse into an invented token.
 */

const ROOT = process.cwd();
const ROOTS = ["app/commercial", "components/commercial"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Index of the `>` that closes the JSX tag opening at `start`.
 *
 * Brace- and quote-aware, because the naive `[^>]` is wrong on `=>`, on a `>`
 * inside a string, and on a nested JSX expression. Returns -1 if the file ends
 * first (a half-written file in this shared tree) — the caller skips it rather
 * than inventing a tag body.
 */
function tagEnd(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

/** Every literal class string inside this tag's `className`, whatever its shape. */
function classStrings(tag: string): string[] {
  const at = tag.search(/\bclassName\s*=/);
  if (at < 0) return [];
  let i = tag.indexOf("=", at) + 1;
  while (i < tag.length && /\s/.test(tag[i])) i++;

  // className="literal"
  if (tag[i] === '"' || tag[i] === "'") {
    const q = tag[i];
    const end = tag.indexOf(q, i + 1);
    return end < 0 ? [] : [tag.slice(i + 1, end)];
  }
  // className={ …any expression… }
  if (tag[i] !== "{") return [];
  let depth = 0;
  let quote: string | null = null;
  let stop = -1;
  for (let k = i; k < tag.length; k++) {
    const c = tag[k];
    if (quote) {
      if (c === "\\") k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      stop = k;
      break;
    }
  }
  const body = tag.slice(i + 1, stop < 0 ? tag.length : stop);
  const out: string[] = [];
  for (const [, s] of body.matchAll(/"([^"\n]*)"/g)) out.push(s);
  for (const [, s] of body.matchAll(/'([^'\n]*)'/g)) out.push(s);
  for (const [, s] of body.matchAll(/`([^`]*)`/g)) out.push(s.replace(/\$\{[^}]*\}/g, " "));
  return out;
}

/** `h-8` → 32, `h-[26px]` → 26, `min-h-[44px]` → 44. Tailwind's scale is 4px/unit. */
function pxOf(token: string): { kind: "min" | "fixed"; px: number } | null {
  let m = /^min-h-\[(\d+(?:\.\d+)?)px\]$/.exec(token);
  if (m) return { kind: "min", px: Number(m[1]) };
  m = /^min-h-(\d+)$/.exec(token);
  if (m) return { kind: "min", px: Number(m[1]) * 4 };
  m = /^h-\[(\d+(?:\.\d+)?)px\]$/.exec(token);
  if (m) return { kind: "fixed", px: Number(m[1]) };
  m = /^h-(\d+)$/.exec(token);
  if (m) return { kind: "fixed", px: Number(m[1]) * 4 };
  return null;
}

type Finding = { key: string; file: string; line: number; tag: string; token: string; px: number };

function findings(): { all: Finding[]; elements: number; withClassName: number } {
  const all: Finding[] = [];
  let elements = 0;
  let withClassName = 0;
  for (const file of ROOTS.flatMap((r) => walk(join(ROOT, r)))) {
    const rel = file.replace(ROOT + "/", "");
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/<(button|a|Link|summary)\b/g)) {
      const end = tagEnd(src, m.index!);
      if (end < 0) continue;
      elements++;
      const strs = classStrings(src.slice(m.index!, end));
      if (strs.length === 0) continue;
      withClassName++;

      // Only UNPREFIXED tokens describe the phone. `sm:min-h-[44px]` is a
      // desktop floor and exempts nothing — reading it as one is how a
      // `min-h-[44px] sm:min-h-[32px]` pattern would get inverted.
      let floor: number | null = null;
      const fixed: Array<[string, number]> = [];
      for (const t of strs.flatMap((s) => s.split(/\s+/)).filter(Boolean)) {
        if (/^[a-z-]+:/.test(t)) continue;
        const hit = pxOf(t);
        if (!hit) continue;
        // SMALLEST, not largest. A className written as
        // `${active ? "min-h-[24px]" : "min-h-[44px]"}` has a state that
        // renders at 24px, and taking the max let the compliant branch vouch
        // for the broken one — a probe planted exactly like that passed.
        // Every reachable state has to clear the floor, so the floor is the
        // smallest one offered.
        if (hit.kind === "min") floor = Math.min(floor ?? Infinity, hit.px);
        else fixed.push([t, hit.px]);
      }
      if (floor !== null && floor >= 44) continue; // min-height clamps h-*, so this is fine

      const line = src.slice(0, m.index!).split("\n").length;
      const push = (token: string, px: number) =>
        all.push({ key: `${rel} :: <${m[1]}> ${token} = ${px}px`, file: rel, line, tag: m[1], token, px });

      if (floor !== null) push(`min-h-[${floor}px]`, floor);
      else for (const [t, px] of fixed) if (px < 44) push(t, px);
    }
  }
  return { all, elements, withClassName };
}

/**
 * The 62 sub-44px targets that were already here when the scanner was widened
 * on 2026-10-16, as counts per file+shape. NOT an exemption — a ratchet.
 *
 * Keyed without line numbers on purpose: several sessions edit this tree at
 * once and a line-pinned baseline would go red on an unrelated insertion,
 * which trains people to regenerate it without reading it. Counted rather than
 * set-deduped so that adding a FIFTH 24px link to a file that already has four
 * still fails.
 *
 * The number may only go DOWN. A count that is now lower fails too, with
 * "lower this number" — a stale entry silently re-opens that many slots.
 */
const BASELINE = new Map<string, number>([
  ["app/commercial/accounting/page.tsx :: <Link> min-h-[36px] = 36px", 2],
  ["app/commercial/accounting/page.tsx :: <Link> min-h-[38px] = 38px", 1],
  ["app/commercial/accounting/page.tsx :: <summary> min-h-[38px] = 38px", 1],
  ["app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx :: <a> min-h-[36px] = 36px", 1],
  ["app/commercial/accounts/[id]/work-order/[dealId]/work-order-tool.tsx :: <Link> min-h-[36px] = 36px", 1],
  ["app/commercial/accounts/page.tsx :: <Link> min-h-[24px] = 24px", 3],
  ["app/commercial/accounts/page.tsx :: <Link> min-h-[40px] = 40px", 1],
  ["app/commercial/email/page.tsx :: <Link> min-h-[38px] = 38px", 1],
  ["app/commercial/field-ops/hours/page.tsx :: <summary> min-h-[32px] = 32px", 1],
  ["app/commercial/guide/page.tsx :: <a> min-h-[40px] = 40px", 1],
  ["app/commercial/invoices/[id]/page.tsx :: <Link> min-h-[40px] = 40px", 1],
  ["app/commercial/invoices/page.tsx :: <Link> min-h-[24px] = 24px", 4],
  ["app/commercial/opportunities/[id]/page.tsx :: <Link> min-h-[24px] = 24px", 4],
  ["app/commercial/opportunities/[id]/page.tsx :: <Link> min-h-[30px] = 30px", 1],
  ["app/commercial/opportunities/[id]/page.tsx :: <Link> min-h-[32px] = 32px", 1],
  ["app/commercial/opportunities/page.tsx :: <Link> h-[26px] = 26px", 1],
  ["app/commercial/opportunities/page.tsx :: <Link> min-h-[24px] = 24px", 3],
  ["app/commercial/opportunities/page.tsx :: <Link> min-h-[40px] = 40px", 2],
  ["app/commercial/proposals/page.tsx :: <Link> min-h-[32px] = 32px", 1],
  ["app/commercial/proposals/page.tsx :: <Link> min-h-[36px] = 36px", 2],
  ["app/commercial/reports/pipeline/page.tsx :: <Link> min-h-[36px] = 36px", 1],
  ["app/commercial/reports/win-loss/page.tsx :: <Link> min-h-[36px] = 36px", 1],
  ["app/commercial/settings/vendors/page.tsx :: <Link> min-h-[36px] = 36px", 1],
  ["components/commercial/add-notification-rule-form.tsx :: <button> min-h-[40px] = 40px", 1],
  ["components/commercial/assistant-panel.tsx :: <button> min-h-[38px] = 38px", 1],
  ["components/commercial/assistant-panel.tsx :: <button> min-h-[40px] = 40px", 1],
  ["components/commercial/command-palette.tsx :: <button> h-7 = 28px", 1],
  ["components/commercial/command-palette.tsx :: <button> h-8 = 32px", 1],
  ["components/commercial/command-palette.tsx :: <button> min-h-[32px] = 32px", 1],
  ["components/commercial/copy-to-clipboard-button.tsx :: <button> h-6 = 24px", 1],
  ["components/commercial/date-field.tsx :: <button> h-8 = 32px", 1],
  ["components/commercial/esign/proposal-signature-panel.tsx :: <summary> min-h-[36px] = 36px", 3],
  ["components/commercial/esign/sign-proposal-form.tsx :: <button> min-h-[40px] = 40px", 2],
  ["components/commercial/exclusion-picker.tsx :: <button> h-8 = 32px", 2],
  ["components/commercial/keyboard-shortcuts.tsx :: <button> h-8 = 32px", 1],
  ["components/commercial/metric-info.tsx :: <button> h-8 = 32px", 1],
  ["components/commercial/new-proposal-picker.tsx :: <button> min-h-[40px] = 40px", 1],
  ["components/commercial/onboarding-walkthrough.tsx :: <button> min-h-[36px] = 36px", 1],
  ["components/commercial/proposals-kanban-dnd.tsx :: <button> min-h-[36px] = 36px", 1],
  ["components/commercial/purchase-form.tsx :: <button> min-h-[32px] = 32px", 1],
  ["components/commercial/searchable-select.tsx :: <button> h-7 = 28px", 1],
  ["components/commercial/self-clearing-flash.tsx :: <button> h-8 = 32px", 1],
  ["components/commercial/tomco-report-page.tsx :: <Link> min-h-[36px] = 36px", 2],
  ["components/commercial/undo-toast.tsx :: <button> h-8 = 32px", 1],
]);

describe("commercial tap targets", () => {
  const { all, elements, withClassName } = findings();

  it("no NEW interactive element is under 44px on a phone", () => {
    const actual = new Map<string, number>();
    for (const f of all) actual.set(f.key, (actual.get(f.key) ?? 0) + 1);

    const fresh: string[] = [];
    for (const [key, n] of actual) {
      const allowed = BASELINE.get(key) ?? 0;
      if (n <= allowed) continue;
      const where = all.filter((f) => f.key === key).map((f) => `${f.file}:${f.line}`).join(", ");
      fresh.push(
        `${key} — ${n} now, ${allowed} allowed (${where}). ` +
          `Use min-h-[44px] with an sm: override for the tighter desktop rhythm.`,
      );
    }
    expect(fresh, `\n${fresh.join("\n")}\n`).toEqual([]);
  });

  it("the baseline only ever shrinks", () => {
    const actual = new Map<string, number>();
    for (const f of all) actual.set(f.key, (actual.get(f.key) ?? 0) + 1);
    const stale: string[] = [];
    for (const [key, n] of BASELINE) {
      const now = actual.get(key) ?? 0;
      if (now < n) stale.push(`${key} — fixed ${n - now}; set BASELINE to ${now}${now === 0 ? " (delete the line)" : ""}`);
    }
    expect(stale, `\n${stale.join("\n")}\n`).toEqual([]);
  });

  it("is actually scanning the platform", () => {
    // Three ways this file has already been silently blind, so three numbers.
    // A regex that stops matching, a tag walker that bails, or a className
    // reader that returns nothing would each pass the checks above in silence.
    expect(elements, "found no interactive elements — the scan is inspecting nothing").toBeGreaterThan(600);
    expect(withClassName, "elements found, but no className read off any of them").toBeGreaterThan(600);
    expect(all.length, "zero sub-44px findings means the height parser stopped parsing").toBeGreaterThan(40);
  });

  it("the height parser understands every spelling it claims to", () => {
    // Proof the ratchet can see each shape, independent of what is on disk.
    expect(pxOf("h-8")).toEqual({ kind: "fixed", px: 32 });
    expect(pxOf("h-[26px]")).toEqual({ kind: "fixed", px: 26 });
    expect(pxOf("min-h-11")).toEqual({ kind: "min", px: 44 });
    expect(pxOf("min-h-[24px]")).toEqual({ kind: "min", px: 24 });
    expect(pxOf("w-8")).toBeNull();
  });

  it("reads a className written as a template literal, both branches", () => {
    // The spelling that hid every segmented control on the platform.
    const tag = '<button onClick={() => go("a")} className={`px-2 ${on ? "min-h-[40px]" : "min-h-[44px]"}`}';
    expect(classStrings(tag).join(" ")).toContain("min-h-[40px]");
    // And the `=>` that used to terminate the tag match early: index 21 is the
    // `>` of the arrow, index 25 is the one that actually closes the tag.
    const withArrow = '<button onClick={() => x}>hi</button>';
    expect(withArrow[21]).toBe(">");
    expect(tagEnd(withArrow, 0)).toBe(25);
    expect(withArrow[25]).toBe(">");
  });
});
