/**
 * THE 375px DEFECTS, FIXED ON THE PHONE ONLY.
 *
 * A production audit at 375px (2026-10-16) measured: the deal h1 squeezed to
 * 23px ("V.."), the account name one word per line, the Action-needed banner
 * cut to "Appro…", the Ask button sitting over the last number on a page, the
 * accounting "Send receivables" button clipped, the Field Ops toolbar running
 * off screen, the KPI label "APPROVED C…", and sub-44px targets.
 *
 * Every fix is confined to below `md` (768px), because Karan's standing rule
 * (10-09) is "the laptop should stay exactly as is". So each test asserts two
 * things about ONE class string: the phone gets the fix, and from md up the
 * original classes are still what applies. A responsive fix with a missing
 * `md:` looks right on the phone it was tested on and silently moves the
 * laptop — nobody is looking at the laptop when they build a phone fix.
 *
 * These are source assertions, normally the weak kind, but the artifact IS a
 * Tailwind class string: there is no viewport in a unit test. Comments are
 * stripped first (the shared parser-based helper).
 *
 * The one change allowed at every width is the dark-theme contrast token,
 * and that is measured as numbers, not spelling: see the last block.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

const cache = new Map<string, string>();
const src = (f: string) => {
  if (!cache.has(f)) cache.set(f, stripComments(readFileSync(f, "utf8")));
  return cache.get(f)!;
};

/** The className of the nearest `<tag` at or before `anchor` in `file`. */
function classOf(file: string, anchor: string, tag = ""): string[] {
  const s = src(file);
  const at = s.indexOf(anchor);
  expect(at, `anchor not found in ${file}: ${anchor}`).toBeGreaterThan(-1);
  const open = tag ? s.lastIndexOf(`<${tag}`, at) : s.lastIndexOf("className=", at);
  const m = s.slice(open, open + 1500).match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
  expect(m, `no className at ${file}: ${anchor}`).toBeTruthy();
  return (m![1] ?? m![2]).replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * The tokens that apply at a given min-width, by breakpoint prefix only.
 * `max-md:*` and `max-sm:*` never apply from 768 up; `sm:`/`md:` do; `lg:`
 * does not at 768. Enough to say "the classes in force at md are these".
 */
const ORDER = ["", "sm:", "md:"];
function inForceAtMd(cls: string[]): string[] {
  return cls.filter((t) => {
    if (/^max-(sm|md|lg):/.test(t)) return false;
    const p = /^(sm:|md:|lg:|xl:|2xl:)/.exec(t)?.[1] ?? "";
    return ORDER.includes(p);
  });
}
const phone = (cls: string[]) => cls.filter((t) => !/^(sm|md|lg|xl|2xl):/.test(t));

const DEAL = "app/commercial/opportunities/[id]/page.tsx";
const ACCOUNT = "app/commercial/accounts/[id]/page.tsx";

describe("deal + account headers stack on a phone, laptop row unchanged", () => {
  it("deal header: column below md, the original justify-between row from md", () => {
    const row = classOf(DEAL, "md:flex-row md:items-start md:justify-between");
    expect(phone(row)).toContain("flex-col");
    for (const t of ["md:flex-row", "md:items-start", "md:justify-between", "md:gap-4", "md:flex-wrap"]) expect(row).toContain(t);

    const title = classOf(DEAL, "{jobDisplayName(opp, account?.company_name ?? null)}\n            </h1>", "div");
    expect(title).toContain("w-full");
    expect(title).toContain("md:flex-1");
    // flex-1 at phone width is THE bug: basis 0 beside a cluster that won't shrink.
    expect(phone(title)).not.toContain("flex-1");

    const h1 = classOf(DEAL, "{jobDisplayName(opp, account?.company_name ?? null)}\n            </h1>", "h1");
    expect(h1).toContain("truncate");
    expect(h1).toContain("max-md:whitespace-normal");
  });

  it("account header: same pattern", () => {
    const row = classOf(ACCOUNT, "md:flex-row md:items-start md:justify-between");
    expect(phone(row)).toContain("flex-col");
    for (const t of ["md:flex-row", "md:items-start", "md:justify-between", "md:flex-wrap"]) expect(row).toContain(t);
    const block = classOf(ACCOUNT, "w-full md:w-auto md:flex-1");
    expect(phone(block)).not.toContain("flex-1");
  });
});

describe("Action-needed banner wraps to two lines on a phone only", () => {
  const F = "components/commercial/action-required-bar.tsx";
  it("title and sub-line clamp at 2 below md, original truncate from md", () => {
    for (const anchor of ["{top.title}</p>", "{top.body}</p>"]) {
      const p = classOf(F, anchor, "p");
      expect(p).toContain("max-md:line-clamp-2");
      expect(p).toContain("max-md:whitespace-normal");
      expect(inForceAtMd(p)).toContain("truncate");
    }
    const box = classOf(F, "{top.title}</p>", "div");
    expect(box).toContain("basis-48"); // lets the buttons drop a row instead of crushing it
    expect(box).toContain("md:basis-0"); // == the original flex-1 at md
  });
});

describe("scroll container clears the Ask button on a phone", () => {
  it("bottom padding below md, original py from md", () => {
    const c = classOf("components/commercial-chrome.tsx", "max-w-7xl mx-auto");
    const pad = c.find((t) => t.startsWith("max-md:pb-"));
    expect(pad, "no phone-only bottom padding").toBeTruthy();
    // Ask is fixed bottom-4 (16px) and min-h-[48px]: clearance must beat 64px.
    expect(Number(/(\d+(?:\.\d+)?)rem/.exec(pad!)![1]) * 16).toBeGreaterThan(64);
    for (const t of ["py-6", "sm:py-8", "lg:py-10"]) expect(c).toContain(t);
    const fab = classOf("components/commercial/assistant-panel.tsx", "aria-expanded={open}", "button");
    expect(fab).toContain("bottom-4");
    expect(fab).toContain("min-h-[48px]");
  });
});

describe("toolbars that ran off a 375 screen now wrap below md", () => {
  it("accounting header actions wrap on a phone, shrink-0 kept from md", () => {
    const c = classOf("app/commercial/accounting/page.tsx", 'data-tour="accounting:print"', "div");
    expect(c).toContain("max-md:flex-wrap");
    expect(c).toContain("max-md:max-w-full");
    expect(inForceAtMd(c)).toContain("shrink-0");
    expect(inForceAtMd(c)).not.toContain("flex-wrap");
  });

  it("field ops calendar toolbar wraps, title on its own line, below md only", () => {
    const F = "components/commercial/field-ops-calendar.tsx";
    const bar = classOf(F, "goPeriod(prevStart)", "div");
    // that's the arrows group; its parent is the toolbar
    expect(bar).toContain("max-md:shrink-0");
    const tb = classOf(F, "flex max-md:flex-wrap items-center gap-2 mb-3");
    expect(inForceAtMd(tb)).not.toContain("flex-wrap");
    const h2 = classOf(F, "{isWeek ? weekLabel(monthStart) : monthLabel(monthStart)}", "h2");
    expect(h2).toContain("basis-full");
    expect(h2).toContain("sm:basis-auto");
    expect(h2).toContain("sm:order-none");
  });

  it("KPI strip label wraps to 2 lines below md, one-line truncate from md", () => {
    const s = classOf("components/commercial/stage-kpi-strip.tsx", "{k.label}</span>", "span");
    expect(s).toContain("max-md:line-clamp-2");
    expect(inForceAtMd(s)).toEqual(["truncate"]);
  });
});

describe("tap targets the 375 audit measured", () => {
  it("each is 44px on a phone and its sm/md value is the original", () => {
    // [file, anchor, tag, desktop tokens that must survive, width needs pinning?]
    // "Add follow-up" is already ~91px wide; only its 18px height was short.
    const cases: Array<[string, string, string, string[], boolean]> = [
      ["components/commercial/metric-info.tsx", "focus-visible:outline-cc-brand-500", "button", ["sm:w-8", "sm:h-8", "sm:-m-1.5"], true],
      ["components/commercial/date-field.tsx", "open calendar", "button", ["sm:h-8", "sm:w-8", "sm:my-0", "sm:-ml-1.5"], true],
      ["components/commercial/status-sub-status-picker.tsx", '"Skip follow-up" : "Add follow-up"', "button", ["sm:min-h-0"], false],
      ["app/commercial/accounts/page.tsx", 'name="account_id"', "label", ["sm:pr-2", "sm:min-w-0"], true],
    ];
    for (const [f, anchor, tag, desk, needW] of cases) {
      const c = classOf(f, anchor, tag);
      const p = phone(c);
      const h = p.some((t) => /^(h-11|min-h-\[44px\])$/.test(t));
      const w = !needW || p.some((t) => /^(w-11|min-w-\[44px\])$/.test(t));
      expect(h, `${f}: no 44px height on the phone`).toBe(true);
      expect(w, `${f}: no 44px width on the phone`).toBe(true);
      for (const t of desk) expect(c, `${f}: desktop token ${t} lost`).toContain(t);
    }
  });

  it("the team is_primary box sits INSIDE its 44px label", () => {
    const s = src(DEAL);
    const i = s.indexOf('id="team_primary"');
    const label = s.lastIndexOf("<label", i);
    expect(s.slice(label, i)).toContain('htmlFor="team_primary"');
    expect(s.slice(label, i)).not.toContain("</label>");
    expect(classOf(DEAL, 'id="team_primary"', "label")).toContain("min-h-[44px]");
  });

  it("inline Settings → Teams links get a 44px band on a phone, plain inline from sm", () => {
    const s = src(DEAL);
    const links = [...s.matchAll(/<Link href="\/commercial\/settings\/teams" className="([^"]*)"/g)].map((m) => m[1].split(/\s+/));
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const c of links) {
      expect(c).toContain("min-h-[44px]");
      expect(c).toContain("sm:inline");
      expect(c).toContain("sm:min-h-0");
      expect(c).toContain("sm:my-0");
    }
  });

  it("the drawer's close button cannot be squeezed under 44 on a phone", () => {
    const c = classOf("components/commercial-sidebar.tsx", 'aria-label="Close menu"', "button");
    expect(c).toContain("max-md:shrink-0");
    expect(c).toContain("w-11");
    const hdr = classOf("components/commercial-sidebar.tsx", '<Link href="/commercial" className="block', "div");
    expect(hdr).toContain("md:pr-6"); // the original px-6 from md up
  });
});

/* ── Dark contrast: the one change allowed at every width ─────────────────── */

const CSS = readFileSync("app/globals.css", "utf8");
const SPLIT = CSS.indexOf('[data-theme="dark"] {');
const tokens = (s: string) => {
  const o: Record<string, string> = {};
  for (const [, k, v] of s.matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g)) o[k] = v.trim();
  return o;
};
const LIGHT = tokens(CSS.slice(0, SPLIT));
const DARK = { ...LIGHT, ...tokens(CSS.slice(SPLIT)) };

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const l = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every bg-* fill in a white-text class string, measured in dark. */
function darkFailures(cls: string[]): string[] {
  const out: string[] = [];
  for (const t of cls) {
    const m = /^(?:hover:|active:)?bg-([a-z]+(?:-[a-z]+)?-\d+)$/.exec(t);
    if (!m) continue;
    const v = DARK["--color-" + m[1]];
    if (!v || !/^#[0-9a-f]{6}$/i.test(v)) { out.push(`${t}: no dark hex`); continue; }
    const r = contrast(v, "#ffffff");
    if (r < 4.5) out.push(`${t}: ${r.toFixed(2)}:1`);
  }
  return out;
}

describe("Action-needed CTA is AA under white in dark", () => {
  const cta = classOf("components/commercial/action-required-bar.tsx", "{ctaFor(top.kind)}", "Link");

  it("rest and hover both clear 4.5:1 in dark", () => {
    expect(cta).toContain("text-white");
    expect(darkFailures(cta)).toEqual([]);
  });

  it("the check CAN fail: the old spelling measures 3.88 and a tan hover", () => {
    // The class string that shipped. If this ever passes, darkFailures is
    // measuring nothing and the test above is laundering a guess.
    const f = darkFailures(["bg-amber-600", "hover:bg-amber-700", "text-white"]);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/3\.88/);
  });

  it("light is byte-for-byte Tailwind's amber, so the laptop in light is unchanged", () => {
    const tw = readFileSync("node_modules/tailwindcss/theme.css", "utf8");
    for (const step of ["600", "700"]) {
      const stock = new RegExp(`--color-amber-${step}:\\s*([^;]+);`).exec(tw)?.[1].trim();
      expect(stock, `tailwind amber-${step} not found`).toBeTruthy();
      expect(LIGHT[`--color-amber-solid-${step}`]).toBe(stock);
    }
  });
});
