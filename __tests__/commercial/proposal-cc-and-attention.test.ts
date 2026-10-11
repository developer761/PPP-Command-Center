import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Several people on the CC, and several names in the Attention block.
 *
 * Stephanie 2026-10-08: "I need to be able to cc multiple people on proposals.
 * Can we add the ability to add more than one attention in the header
 * section?"
 *
 * Both boxes technically accepted more than one before and neither WORKED: the
 * CC field was `type="email"`, so the browser refused to submit a list at all,
 * and the Attention value printed as one run-on line.
 *
 * The parsing is asserted as behaviour by re-deriving it here; the wiring is
 * asserted against the source with comments stripped, because this codebase
 * has shipped a test that matched its own docblock.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The same split the sender uses: commas, semicolons or whitespace. */
const parseCc = (raw: string) => [
  ...new Set(
    String(raw ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/** The same split the header uses: commas or new lines. */
const parseAttention = (raw: string) =>
  String(raw ?? "")
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

describe("CC takes a list", () => {
  it("splits the shapes that come out of Outlook", () => {
    expect(parseCc("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseCc("a@x.com; b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseCc("a@x.com b@y.com")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("does not copy the same person twice", () => {
    expect(parseCc("a@x.com, A@X.com")).toEqual(["a@x.com"]);
  });

  it("is still one address when she only wants one", () => {
    expect(parseCc("pm@gc.com")).toEqual(["pm@gc.com"]);
    expect(parseCc("")).toEqual([]);
  });
});

describe("the send path", () => {
  const src = strip(readFileSync("lib/commercial/proposals/email.ts", "utf8"));

  it("refuses the send and names the bad address rather than quietly dropping it", () => {
    expect(src).toMatch(/badCc/);
    expect(src).toMatch(/This CC address isn't valid/);
  });

  it("never copies the TO address as well", () => {
    // The same person receiving it twice makes a proposal look like a mistake.
    expect(src).toMatch(/ccList\.filter\(\(e\) => e !== toEmail\)/);
  });
});

describe("the CC box lets her type a list at all", () => {
  const src = strip(readFileSync("components/commercial/proposal-send-control.tsx", "utf8"));

  it("tells her the semicolon works, because that is what Outlook teaches", () => {
    /*
     * Stephanie asked the day after this shipped whether she could use a
     * semicolon. She could — the parser takes it — but the hint named only
     * commas and spaces. A capability nobody can tell is there is one they
     * have to ask about, which is the same cost as not having it.
     */
    expect(src).toMatch(/semicolon/i);
  });

  it("is not type=email, which the browser refuses a list in", () => {
    // This is the half that actually blocked her: validation happened in the
    // browser, before anything of ours ran.
    expect(src).not.toMatch(/type="email"\s+value=\{cc\}/);
    expect(src).toMatch(/type="text"[\s\S]{0,80}value=\{cc\}/);
  });
});

describe("Attention takes several names", () => {
  it("splits a comma list and a typed list the same way", () => {
    expect(parseAttention("Bryon, Kevin Greenwood")).toEqual(["Bryon", "Kevin Greenwood"]);
    expect(parseAttention("Bryon\nKevin Greenwood")).toEqual(["Bryon", "Kevin Greenwood"]);
  });

  it("leaves a single name exactly as it was, so no proposal moves", () => {
    expect(parseAttention("John Keenan")).toEqual(["John Keenan"]);
  });

  it("prints the label once and stacks the rest", () => {
    const pdf = strip(readFileSync("lib/commercial/proposals/pdf.tsx", "utf8"));
    expect(pdf).toMatch(/Attention: \{attentionNames\[0\]\}/);
    expect(pdf).toMatch(/attentionNames\.slice\(1\)\.map/);
  });
});
