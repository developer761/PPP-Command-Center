import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, Svg, Polygon, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";

import { ROLES, JOURNEY, LOOKUP } from "./roles";
import { extraControls } from "./walkthrough";
import type { RoleGuide, Surface, Strip } from "./walkthrough";

/**
 * "Running Commercial Work" — the handbook, printed.
 *
 * Karan 2026-09-16: "simple and easy to understand, with arrows and stuff."
 *
 * DRAWN, NOT SCREENSHOTTED. Every diagram here is boxes and a chevron built out
 * of Views. Screenshots would be more literal for a week and wrong for ever
 * after: this platform changes most days, and a handbook illustrated with last
 * month's buttons teaches people a layout that is no longer there. A schematic
 * stays true as long as the tab is called what it is called — which the tests
 * check.
 *
 * It also has to survive a black-and-white office printer, so nothing depends
 * on color to be readable: the arrow is a shape, the step numbers are numbers,
 * and the orange is emphasis on top of a layout that already works without it.
 */

Font.registerHyphenationCallback((word) => [word]);

/**
 * PPP's palette, not a document-grey one.
 *
 * Karan 2026-09-17: "use PPP colors, just Tomco's logo." The handbook is a PPP
 * product that Tomco use, so it wears PPP's colors and Tomco's mark.
 *
 * WHERE THE COLOR DOES WORK RATHER THAN DECORATION: each person gets one, used
 * on their divider sheet, their running header and their step numbers. Fanning
 * the handbook shows you where Mary's section ends and Brendan's starts without
 * reading a word.
 *
 * Text on a tint is always NAVY. White on the brand blue measures 2.64:1, which
 * fails AA, and the same trap is waiting on the green — so the tints carry the
 * color and the ink stays readable.
 */
const ORANGE = "#EE662E";
const BLUE = "#2BAAE1";
const GREEN = "#8DC442";
const NAVY = "#172B4D";
const TEAL = "#37738C";
const LIGHT_BLUE = "#C4DDE4";
const PALE_GREEN = "#E9F4D4";
const WARM_BEIGE = "#F0E8DD";
const INK = "#3F3E40";
const GREY = "#6b7280";
const RULE = "#e5e7eb";

/** One color per person, so a section is findable by its edge alone. */
const ROLE_COLOR: Record<string, { accent: string; tint: string }> = {
  overview: { accent: NAVY, tint: LIGHT_BLUE },
  mary: { accent: TEAL, tint: LIGHT_BLUE },
  brendan: { accent: GREEN, tint: PALE_GREEN },
  stephanie: { accent: ORANGE, tint: WARM_BEIGE },
};
const colorFor = (key: string) => ROLE_COLOR[key] ?? { accent: NAVY, tint: LIGHT_BLUE };


/**
 * The PDF base-14 fonts are WinAnsi only, and react-pdf does not warn — it
 * prints the nearest byte. The first draft of this handbook shipped
 * "Accounting → Labor payments" and rendered "Accounting ' Labor payments",
 * with an arrow that came out as a superscript 2. Silent, and only visible by
 * looking at the rendered page.
 *
 * So: nothing outside WinAnsi reaches a Text node. Arrows are drawn as SVG
 * (see Triangle below) and the few characters worth keeping are mapped to a
 * glyph that exists. `__tests__` asserts the content file contains nothing
 * outside this set, so a future edit cannot reintroduce it.
 */
const GLYPH_SWAP: Record<string, string> = {
  "\u2192": "\u203A", // → becomes › , which WinAnsi has
  "\u2190": "\u2039", // ←
  "\u25B2": "",        // ▲ — drawn, never typed
  "\u25B6": "",        // ▶
};
/**
 * WinAnsi is Latin-1 PLUS a supplement in the 0x80–0x9F slots — the em dash,
 * the curly quotes, the bullet, the ellipsis, the angle quotes.
 *
 * Getting this wrong in the obvious direction costs you real punctuation: the
 * second draft stripped everything above U+00FF, which quietly deleted every
 * em dash in the handbook and printed "the platform now disagree  check the
 * amount" — a sentence with a hole in it, on the page that warns about the
 * bank not matching.
 */
const WINANSI_EXTRA =
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ" +
  "‘’“”•–—˜™š›œžŸ";

export function pdfSafe(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(GLYPH_SWAP)) out = out.split(from).join(to);
  // Anything the font cannot represent would print as a WRONG character rather
  // than fail, so it is dropped: a missing character is visible, a wrong one
  // reads as a typo nobody traces back to the renderer.
  return [...out].filter((c) => c <= "ÿ" || WINANSI_EXTRA.includes(c)).join("");
}

/** An arrow head, drawn. Typed triangles do not survive the base-14 fonts. */
function Triangle({ dir, size = 9, color = ORANGE }: { dir: "up" | "right"; size?: number; color?: string }) {
  const w = dir === "up" ? size + 3 : size;
  const h = dir === "up" ? size : size + 3;
  return (
    <Svg width={w} height={h}>
      <Polygon points={dir === "up" ? `${w / 2},0 ${w},${h} 0,${h}` : `0,0 ${w},${h / 2} 0,${h}`} fill={color} />
    </Svg>
  );
}

const s = StyleSheet.create({
  page: { paddingTop: 46, paddingBottom: 54, paddingHorizontal: 46, fontSize: 10, fontFamily: "Helvetica", color: INK, lineHeight: 1.45 },
  cover: { paddingTop: 150, paddingBottom: 54, paddingHorizontal: 64, fontFamily: "Helvetica", color: INK },

  logoImage: { height: 40, objectFit: "contain", alignSelf: "center" },
  logoImageBig: { height: 72, objectFit: "contain", alignSelf: "center" },
  wordmark: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: 1, textAlign: "center", color: NAVY },

  coverTitle: { fontSize: 38, fontFamily: "Helvetica-Bold", color: NAVY, textAlign: "center", marginTop: 34, letterSpacing: -1, lineHeight: 1.12 },
  coverSub: { fontSize: 12, color: "#3E5471", textAlign: "center", marginTop: 16 },
  coverRule: { borderBottomWidth: 3, borderBottomColor: ORANGE, width: 70, alignSelf: "center", marginTop: 26, marginBottom: 26 },
  coverMeta: { fontSize: 8.5, color: "#8A97A8", textAlign: "center", letterSpacing: 1.4, marginTop: 44 },
  coverBand: { position: "absolute", top: 0, left: 0, right: 0, height: 10, flexDirection: "row" },

  // Running header on every page after the cover.
  runHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", borderBottomWidth: 0.75, borderBottomColor: RULE, paddingBottom: 5, marginBottom: 16 },
  runHeadTitle: { fontSize: 8, color: "#9ca3af", letterSpacing: 0.6, textTransform: "uppercase" },

  h1: { fontSize: 22, fontFamily: "Helvetica-Bold", color: NAVY, letterSpacing: -0.5 },
  whoChip: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: NAVY, backgroundColor: LIGHT_BLUE, paddingVertical: 3, paddingHorizontal: 7, borderRadius: 2, textTransform: "uppercase", letterSpacing: 0.6 },
  intro: { fontSize: 10.5, color: GREY, marginTop: 6, marginBottom: 16, lineHeight: 1.5 },

  task: { marginBottom: 26 },
  taskTitle: { fontSize: 13.5, fontFamily: "Helvetica-Bold", color: NAVY },
  taskPath: { fontSize: 8.5, color: ORANGE, fontFamily: "Helvetica-Bold", marginTop: 2, marginBottom: 8, letterSpacing: 0.2 },

  step: { flexDirection: "row", marginBottom: 6, alignItems: "flex-start" },
  // lineHeight 1 is load-bearing: the page's 1.45 pushed the digit out of the
  // circle and the first render came out as plain navy dots.
  stepNum: { width: 16, height: 16, borderRadius: 8, backgroundColor: NAVY, color: "#ffffff", fontSize: 8.5, fontFamily: "Helvetica-Bold", textAlign: "center", lineHeight: 1, paddingTop: 4, marginRight: 8 },
  stepText: { flex: 1, fontSize: 10.5, lineHeight: 1.45, paddingTop: 0.5 },
  purpose: { fontSize: 9.5, color: "#374151", lineHeight: 1.45, marginBottom: 6 },
  dividerName: { fontSize: 46, fontFamily: "Helvetica-Bold", color: NAVY, letterSpacing: -1.2, lineHeight: 1.1 },
  dividerTag: { fontSize: 13, color: "#3E5471", marginTop: 8, lineHeight: 1.3 },
  dividerChapter: { fontSize: 11, color: "#3E5471", marginBottom: 6, lineHeight: 1.3 },
  dividerFoot: { position: "absolute", bottom: 34, left: 66, fontSize: 8, color: "#6E7F94", letterSpacing: 0.8, textTransform: "uppercase" },
  roleHead: { marginBottom: 14 },
  roleIntro: { fontSize: 10, color: GREY, lineHeight: 1.5, marginTop: 5 },
  h2: { fontSize: 13.5, fontFamily: "Helvetica-Bold", color: NAVY },
  chapterHead: { marginTop: 8, marginBottom: 10, borderTopWidth: 2, borderTopColor: ORANGE, paddingTop: 7 },
  chapterBlurb: { fontSize: 9.5, color: GREY, lineHeight: 1.45, marginTop: 2 },
  ctrlHead: { fontSize: 7.5, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.6, color: "#9ca3af", marginBottom: 4 },
  extrasBox: { marginTop: 9, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: RULE },
  refRow: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: RULE },
  refName: { fontSize: 10, fontFamily: "Helvetica-Bold", color: INK },
  refPath: { fontSize: 7.5, color: ORANGE, fontFamily: "Helvetica-Bold", marginTop: 1 },
  refPurpose: { flex: 1, fontSize: 9, color: "#374151", lineHeight: 1.4 },
  tocRow: { flexDirection: "row", paddingVertical: 3.4, borderBottomWidth: 0.5, borderBottomColor: RULE },
  tocWho: { width: "26%", fontSize: 10, fontFamily: "Helvetica-Bold", color: NAVY },
  tocWhat: { flex: 1, fontSize: 9.5, color: "#374151" },
  ctrlRow: { flexDirection: "row", paddingVertical: 3.2 },
  ctrlLabel: { width: "30%", paddingRight: 10, fontSize: 9, fontFamily: "Helvetica-Bold", color: INK, lineHeight: 1.35 },
  ctrlDoes: { flex: 1, fontSize: 9, color: GREY, lineHeight: 1.4 },

  watchBox: { flexDirection: "row", borderLeftWidth: 3, borderLeftColor: ORANGE, backgroundColor: WARM_BEIGE, paddingVertical: 8, paddingHorizontal: 10, marginTop: 10, borderRadius: 2 },
  watchLabel: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: ORANGE, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 },
  watchText: { fontSize: 9.5, color: "#5c3a24", lineHeight: 1.45 },

  // The schematic.
  sketchWrap: { marginBottom: 9, marginTop: 2 },
  sketchRow: { flexDirection: "row", borderRadius: 3, backgroundColor: "#f4f6f8" },
  sketchBox: { paddingVertical: 6, paddingHorizontal: 7, fontSize: 8.5, color: "#475569", textAlign: "center" },
  sketchBoxOn: { fontFamily: "Helvetica-Bold", color: NAVY, backgroundColor: "#ffffff", borderBottomWidth: 2, borderBottomColor: BLUE },
  arrowLine: { flexDirection: "row", marginTop: 3, alignItems: "flex-start" },
  arrowLabel: { fontSize: 8.5, color: ORANGE, fontFamily: "Helvetica-Bold", marginLeft: 4, lineHeight: 1.3 },

  // Tables.
  tHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: NAVY, paddingBottom: 4, marginBottom: 1 },
  th: { fontSize: 8, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.4, color: "#374151" },
  tr: { flexDirection: "row", paddingVertical: 4.5, borderBottomWidth: 0.5, borderBottomColor: RULE },
  trDivider: { flexDirection: "row", paddingVertical: 5, backgroundColor: "#f8fafc", borderBottomWidth: 0.5, borderBottomColor: RULE },
  cKey: { width: "30%", paddingRight: 8, fontFamily: "Helvetica-Bold", fontSize: 9.5 },
  cVal: { width: "70%", fontSize: 9.5, color: "#374151" },

  // The journey strip + area cards on the map page.
  journeyRow: { flexDirection: "row", marginBottom: 20, alignItems: "stretch" },
  jStep: { flex: 1, borderRadius: 3, paddingVertical: 7, paddingHorizontal: 4, backgroundColor: LIGHT_BLUE },
  jLabel: { fontSize: 9, fontFamily: "Helvetica-Bold", color: NAVY, textAlign: "center" },
  jSub: { fontSize: 6.8, color: "#3E5471", textAlign: "center", marginTop: 2, lineHeight: 1.25 },
  jChevron: { width: 13, alignItems: "center", justifyContent: "center", paddingTop: 12 },

  areaCard: { borderLeftWidth: 3, borderLeftColor: BLUE, borderRadius: 2, paddingLeft: 11, paddingVertical: 7, marginBottom: 9, backgroundColor: "#fbfcfd" },
  areaName: { fontSize: 11.5, fontFamily: "Helvetica-Bold", color: NAVY },
  areaWho: { fontSize: 7.5, color: ORANGE, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 1 },
  areaHolds: { fontSize: 9.5, color: "#374151", marginTop: 4, lineHeight: 1.4 },

  // 2.8, not 3.6: at the looser spacing the 28th question orphaned onto a
  // page of its own, which is a whole sheet of paper for one line.
  lookupRow: { flexDirection: "row", paddingVertical: 2.8, borderBottomWidth: 0.5, borderBottomColor: RULE },
  lookupQ: { width: "52%", fontSize: 9.5, paddingRight: 8, lineHeight: 1.3 },
  lookupA: { width: "48%", fontSize: 9.5, fontFamily: "Helvetica-Bold", color: NAVY, lineHeight: 1.3 },

  footnote: { fontSize: 8.5, color: "#9ca3af", marginTop: 12, lineHeight: 1.4, fontStyle: "italic" },
  footer: { position: "absolute", bottom: 28, left: 46, right: 46, borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 6, flexDirection: "row", justifyContent: "space-between" },
  footerText: { fontSize: 7.5, color: "#9ca3af" },
});

function fmtToday(): string {
  const d = new Date();
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const et = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [y, m, day] = et.split("-").map(Number);
  return `${months[m - 1]} ${day}, ${y}`;
}

function RunningHeader({ company, title }: { company: string; title: string }) {
  return (
    <View style={s.runHead} fixed>
      <Text style={s.runHeadTitle}>{company} · Running commercial work</Text>
      <Text style={s.runHeadTitle}>{title}</Text>
    </View>
  );
}

function Footer({ company }: { company: string }) {
  return (
    <View style={s.footer} fixed>
      <Text style={s.footerText}>{company} — Commercial Command Center</Text>
      <Text style={s.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} of ${totalPages}`} />
    </View>
  );
}

/**
 * The schematic: a row of boxes with one picked out, and an arrow under it.
 *
 * The arrow is positioned by giving the spacer before it the same flex weights
 * as the boxes it sits under — react-pdf has no absolute positioning worth
 * trusting across page breaks, and this survives a re-flow.
 */
function SketchView({ sketch }: { sketch: Strip }) {
  return (
    <View style={s.sketchWrap} wrap={false}>
      <View style={s.sketchRow}>
        {sketch.boxes.map((b, i) => (
          <Text key={i} style={[s.sketchBox, { flex: 1 }, i === sketch.at ? s.sketchBoxOn : {}]}>
            {b}
          </Text>
        ))}
      </View>
      <View style={s.arrowLine}>
        {/* Spacer in the same proportion as the boxes before the target, so the
            arrow head lands under it at any width. The LABEL gets the rest of
            the row rather than the target box's share — pinned to the box it
            ran off the right-hand edge, which is how the first draft printed
            "…paying a crew or labor comp". */}
        {sketch.at > 0 && <View style={{ flex: sketch.at }} />}
        <View style={{ flex: sketch.boxes.length - sketch.at, flexDirection: "row", alignItems: "flex-start" }}>
          <View style={{ paddingTop: 1 }}>
            <Triangle dir="up" />
          </View>
          {/* No label: the tab above is already picked out in bold with an
              orange rule under it, so printing its name again beside the arrow
              said the same thing three times. */}
        </View>
      </View>
    </View>
  );
}

function SurfaceView({ surface, accent }: { surface: Surface; accent: string }) {
  // Only the controls the steps do not already walk through.
  const extras = extraControls(surface);
  const hasDetail = (surface.steps?.length ?? 0) > 0 || extras.length > 0;
  // A surface with nothing but a purpose is a REFERENCE line, not a procedure.
  // Given the full block treatment it ate a third of a page to say one sentence.
  if (!hasDetail && !surface.watchOut) {
    return (
      <View style={s.refRow} wrap={false}>
        <View style={{ width: "32%", paddingRight: 10 }}>
          <Text style={s.refName}>{pdfSafe(surface.name)}</Text>
          <Text style={[s.refPath, { color: accent }]}>{pdfSafe(surface.path)}</Text>
        </View>
        <Text style={s.refPurpose}>{pdfSafe(surface.purpose)}</Text>
      </View>
    );
  }
  return (
    <View style={s.task}>
      {/*
        A SECTION STARTS ON A PAGE, OR IT STARTS THE NEXT ONE.

        Katie, 2026-09-17: "Labor Payments begins with a few lines at the bottom
        of the 7th page and then spills over to the 8th. It would be best if the
        beginning of a section happens at the beginning of a new page, or in the
        middle of one — if it would create too much dead space in the doc."

        The first attempt was `minPresenceAhead` on this block, and it did not
        work: Labor payments still opened four lines from the foot of page 7.
        The threshold only asks whether SOME space remains, and the heading, the
        tab strip, the purpose line and step one all fit inside it — which is
        precisely the sliver Katie was pointing at. Raising the number far
        enough to stop it cost four pages of white, the dead space she warned
        about in the same breath.

        So the rule is structural instead of numeric: the OPENING of a section —
        its heading, path, tab strip, purpose and first three steps — is one
        unbreakable unit. It cannot be split, so it either fits where it is or
        it moves to the next page whole. No threshold to tune, and a section
        that genuinely fits lower down still starts there.
      */}
      <View wrap={false}>
        <Text style={s.taskTitle}>{pdfSafe(surface.name)}</Text>
        <Text style={[s.taskPath, { color: accent }]}>{pdfSafe(surface.path)}</Text>
        {surface.strip && <SketchView sketch={surface.strip} />}
        <Text style={s.purpose}>{pdfSafe(surface.purpose)}</Text>
        {(surface.steps ?? []).slice(0, 3).map((st, i) => (
          <View key={i} style={s.step}>
            <Text style={[s.stepNum, { backgroundColor: accent }]}>{i + 1}</Text>
            <Text style={s.stepText}>{pdfSafe(st)}</Text>
          </View>
        ))}
      </View>
      {(surface.steps ?? []).slice(3).map((st, i) => (
        <View key={i + 3} style={s.step} wrap={false}>
          <Text style={[s.stepNum, { backgroundColor: accent }]}>{i + 4}</Text>
          <Text style={s.stepText}>{pdfSafe(st)}</Text>
        </View>
      ))}
      {extras.length > 0 && (
        <View style={s.extrasBox}>
          <Text style={s.ctrlHead} wrap={false}>Also on this page</Text>
          {extras.map((c) => (
            <View key={c.label} style={s.ctrlRow} wrap={false}>
              <Text style={s.ctrlLabel}>
                {pdfSafe(c.label)}
                {c.required ? "  (required)" : ""}
              </Text>
              <Text style={s.ctrlDoes}>{pdfSafe(c.does)}</Text>
            </View>
          ))}
        </View>
      )}
      {surface.watchOut && (
        <View style={[s.watchBox, { borderLeftColor: accent }]} wrap={false}>
          <View style={{ flex: 1 }}>
            <Text style={s.watchLabel}>Watch out</Text>
            <Text style={s.watchText}>{pdfSafe(surface.watchOut)}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * A person's whole walkthrough, flowing.
 *
 * Deliberately ONE <Page> per role, not one per chapter. The first version gave
 * every chapter its own page and marked each surface `wrap={false}`, which
 * produced pages carrying a single three-line entry and three inches of white
 * under it — a sheet of paper for "Crew: adding a crew member". react-pdf
 * paginates a long page by itself; what it needs from us is small
 * keep-together units, not one enormous one.
 */
/**
 * The sheet that says whose section this is.
 *
 * Karan 2026-09-17: "when Brendan's page starts, have a page with only his name
 * on it so we know that's the start." A 23-page handbook where three people's
 * work runs together is one nobody can hand to one of them. This is the divider
 * you get in a ring binder, and it does the same job: a full tint, the name,
 * and the short list of what is inside.
 */
function DividerPage({ role, company }: { role: RoleGuide; company: string }) {
  const { accent, tint } = colorFor(role.key);
  return (
    <Page size="LETTER" style={[s.page, { backgroundColor: tint }]}>
      <View style={{ paddingHorizontal: 20, marginTop: 250 }}>
        <View style={{ width: 54, height: 5, backgroundColor: accent, marginBottom: 22 }} />
        <Text style={s.dividerName}>{pdfSafe(role.label)}</Text>
        <Text style={s.dividerTag}>{pdfSafe(role.tagline)}</Text>
        <View style={{ height: 1, backgroundColor: "#AFC4D2", marginTop: 28, marginBottom: 18 }} />
        {role.chapters.map((c) => (
          <Text key={c.id} style={s.dividerChapter}>
            {pdfSafe(c.title)}
          </Text>
        ))}
      </View>
      <Text style={s.dividerFoot} fixed>
        {pdfSafe(company)}
      </Text>
    </Page>
  );
}

/**
 * A person's walkthrough, flowing, in their color.
 *
 * One <Page> per role, not one per chapter: react-pdf paginates a long page by
 * itself, and the first version's page-per-chapter left sheets carrying a
 * single three-line entry.
 */
function RolePages({ role, company }: { role: RoleGuide; company: string }) {
  const { accent } = colorFor(role.key);
  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.runHead} fixed>
        <Text style={s.runHeadTitle}>{pdfSafe(company)}</Text>
        <Text style={[s.runHeadTitle, { color: accent, fontFamily: "Helvetica-Bold" }]}>
          {pdfSafe(role.label)}
        </Text>
      </View>
      {role.chapters.map((c) => (
        <View key={c.id}>
          <View style={s.chapterHead} wrap={false}>
            <View style={{ width: 28, height: 3, backgroundColor: accent, marginBottom: 7 }} />
            <Text style={s.h2}>{pdfSafe(c.title)}</Text>
            <Text style={s.chapterBlurb}>{pdfSafe(c.blurb)}</Text>
          </View>
          {c.surfaces.map((su, i) => (
            <SurfaceView key={i} surface={su} accent={accent} />
          ))}
        </View>
      ))}
      <Footer company={company} />
    </Page>
  );
}

function GuideDoc({ company, logo }: { company: string; logo: Buffer | null }) {
  return (
    <Document title={`${company} — Running Commercial Work`} author={company}>
      {/* ── Cover ── */}
      <Page size="LETTER" style={s.cover}>
        {/* The three PPP colors as a band across the head of the sheet —
            the logo's own colors, doing the job a logo cannot do at this size. */}
        <View style={s.coverBand} fixed>
          <View style={{ flex: 1, backgroundColor: ORANGE }} />
          <View style={{ flex: 1, backgroundColor: BLUE }} />
          <View style={{ flex: 1, backgroundColor: GREEN }} />
        </View>
        <View style={{ marginTop: 150 }}>
          {logo ? <Image src={logo} style={s.logoImageBig} /> : <Text style={s.wordmark}>{company}</Text>}
          <Text style={s.coverTitle}>Running{"\n"}Commercial Work</Text>
          <Text style={s.coverSub}>How to do everything, and who does what.</Text>
          <Text style={s.coverMeta}>{fmtToday().toUpperCase()}</Text>
        </View>
      </Page>

      {/* ── Contents ──
          Twenty pages without one is a document people flick through and give
          up on. Whose section, and what is in it. */}
      <Page size="LETTER" style={s.page}>
        <RunningHeader company={company} title="Contents" />
        <Text style={s.h1}>What is in here</Text>
        <Text style={s.intro}>
          Find your name. Each section covers only the pages that person uses, and what every button on them does.
        </Text>
        {ROLES.map((r) => (
          <View key={r.key} style={{ marginBottom: 14 }} wrap={false}>
            <View style={s.tocRow}>
              {/* The same color as this person's divider sheet, so "the green
                  section" means one thing in both places. */}
              <View style={{ width: 8, height: 8, backgroundColor: colorFor(r.key).accent, marginRight: 8, marginTop: 3 }} />
              <Text style={s.tocWho}>{pdfSafe(r.label === "Everything" ? "Everyone" : r.label)}</Text>
              <Text style={s.tocWhat}>{pdfSafe(r.tagline)}</Text>
            </View>
            {r.chapters.map((c) => (
              <View key={c.id} style={s.tocRow}>
                <View style={{ width: 8, marginRight: 8 }} />
                <Text style={[s.tocWho, { fontFamily: "Helvetica", color: GREY, fontSize: 9 }]}> </Text>
                <Text style={[s.tocWhat, { color: GREY }]}>
                  {/* "screens", not "pages": this document has its own page
                      numbers at the foot, and "Every day — 4 pages" read as
                      four sheets of paper rather than four places in the app. */}
                  {pdfSafe(c.title)} — {c.surfaces.length} {c.surfaces.length === 1 ? "screen" : "screens"}
                </Text>
              </View>
            ))}
          </View>
        ))}
        <Text style={s.footnote}>
          The last sheet is a &quot;Where do I…&quot; list — the quickest way in when you know the job but not the page.
          Pin that one up.
        </Text>
        <Footer company={company} />
      </Page>

      {/* ── The map ── */}
      <Page size="LETTER" style={s.page}>
        <RunningHeader company={company} title="The map" />
        <Text style={s.h1}>How a job moves</Text>
        <Text style={s.intro}>
          Every job takes the same path. Wherever you are in the platform, you are somewhere on this line.
        </Text>
        <View style={s.journeyRow}>
          {JOURNEY.map((j, i) => (
            <React.Fragment key={j.label}>
              <View style={s.jStep}>
                <Text style={s.jLabel}>{j.label}</Text>
                <Text style={s.jSub}>{j.sub}</Text>
              </View>
              {i < JOURNEY.length - 1 && (
                <View style={s.jChevron}>
                  <Triangle dir="right" size={7} />
                </View>
              )}
            </React.Fragment>
          ))}
        </View>

        <Text style={[s.h1, { fontSize: 15, marginBottom: 4 }]}>The five places</Text>
        <Text style={[s.intro, { marginBottom: 12 }]}>
          Left-hand menu. If you are not sure where something is, it is in one of these.
        </Text>
        {ROLES[0].chapters[0].surfaces.map((a) => (
          <View key={a.name} style={s.areaCard} wrap={false}>
            <Text style={s.areaName}>{pdfSafe(a.name)}</Text>
            <Text style={s.areaHolds}>{pdfSafe(a.purpose)}</Text>
          </View>
        ))}
        <Text style={s.footnote}>
          Stuck? Press Ask at the bottom right of any page and type the question in your own words. It will tell you
          where to go and take you there.
        </Text>
        <Footer company={company} />
      </Page>

      {/* ── One page per section ── */}
      {/* One page per chapter, per person. The overview role is the map page
          above, so it is not repeated here. */}
      {ROLES.filter((r) => r.key !== "overview").flatMap((r) => [
        <DividerPage key={`${r.key}-div`} role={r} company={company} />,
        <RolePages key={r.key} role={r} company={company} />,
      ])}

      {/* ── The index ── */}
      <Page size="LETTER" style={s.page}>
        <RunningHeader company={company} title="Where do I…" />
        <Text style={s.h1}>Where do I…</Text>
        <Text style={s.intro}>The short answer to the questions people ask most. Pin this one up.</Text>
        {LOOKUP.map((l, i) => (
          <View key={i} style={s.lookupRow} wrap={false}>
            <Text style={s.lookupQ}>{pdfSafe(l.question)}</Text>
            <Text style={s.lookupA}>{pdfSafe(l.answer)}</Text>
          </View>
        ))}
        <Footer company={company} />
      </Page>
    </Document>
  );
}

export async function renderGuidePdf(input: { company: string; logo: Buffer | null }): Promise<Buffer> {
  return renderToBuffer(<GuideDoc {...input} />);
}
