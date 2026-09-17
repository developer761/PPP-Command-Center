import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, Svg, Polygon, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";

import { SECTIONS, AREAS, JOURNEY, LOOKUP, type Section, type Task, type Sketch } from "./content";

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

const ORANGE = "#EE662E";
const NAVY = "#172B4D";
const INK = "#1f2937";
const GREY = "#6b7280";
const RULE = "#e5e7eb";


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

  coverTitle: { fontSize: 30, fontFamily: "Helvetica-Bold", color: NAVY, textAlign: "center", marginTop: 30, letterSpacing: -0.4 },
  coverSub: { fontSize: 11.5, color: GREY, textAlign: "center", marginTop: 10, lineHeight: 1.5 },
  coverRule: { borderBottomWidth: 3, borderBottomColor: ORANGE, width: 70, alignSelf: "center", marginTop: 26, marginBottom: 26 },
  coverMeta: { fontSize: 8.5, color: "#9ca3af", textAlign: "center", letterSpacing: 0.4 },

  // Running header on every page after the cover.
  runHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", borderBottomWidth: 0.75, borderBottomColor: RULE, paddingBottom: 5, marginBottom: 16 },
  runHeadTitle: { fontSize: 8, color: "#9ca3af", letterSpacing: 0.6, textTransform: "uppercase" },

  h1: { fontSize: 19, fontFamily: "Helvetica-Bold", color: NAVY, letterSpacing: -0.2 },
  whoChip: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: "#ffffff", backgroundColor: NAVY, paddingVertical: 2.5, paddingHorizontal: 6, borderRadius: 2, textTransform: "uppercase", letterSpacing: 0.6 },
  intro: { fontSize: 10.5, color: GREY, marginTop: 6, marginBottom: 16, lineHeight: 1.5 },

  task: { marginBottom: 20 },
  taskTitle: { fontSize: 12.5, fontFamily: "Helvetica-Bold", color: INK },
  taskPath: { fontSize: 8.5, color: ORANGE, fontFamily: "Helvetica-Bold", marginTop: 2, marginBottom: 8, letterSpacing: 0.2 },

  step: { flexDirection: "row", marginBottom: 5, alignItems: "flex-start" },
  // lineHeight 1 is load-bearing: the page's 1.45 pushed the digit out of the
  // circle and the first render came out as plain navy dots.
  stepNum: { width: 16, height: 16, borderRadius: 8, backgroundColor: NAVY, color: "#ffffff", fontSize: 8.5, fontFamily: "Helvetica-Bold", textAlign: "center", lineHeight: 1, paddingTop: 4, marginRight: 8 },
  stepText: { flex: 1, fontSize: 10, lineHeight: 1.45, paddingTop: 1 },

  watchBox: { flexDirection: "row", borderLeftWidth: 3, borderLeftColor: ORANGE, backgroundColor: "#fdf4ef", paddingVertical: 7, paddingHorizontal: 9, marginTop: 9, borderRadius: 2 },
  watchLabel: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: ORANGE, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 },
  watchText: { fontSize: 9, color: "#7c3a1d", lineHeight: 1.45 },

  // The schematic.
  sketchWrap: { marginBottom: 9, marginTop: 2 },
  sketchRow: { flexDirection: "row", borderWidth: 0.75, borderColor: "#cbd5e1", borderRadius: 3, backgroundColor: "#f8fafc" },
  sketchBox: { paddingVertical: 6, paddingHorizontal: 7, fontSize: 8.5, color: "#475569", textAlign: "center" },
  sketchBoxOn: { fontFamily: "Helvetica-Bold", color: NAVY, backgroundColor: "#ffffff", borderBottomWidth: 2, borderBottomColor: ORANGE },
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
  jStep: { flex: 1, borderWidth: 0.75, borderColor: "#cbd5e1", borderRadius: 3, paddingVertical: 6, paddingHorizontal: 4, backgroundColor: "#f8fafc" },
  jLabel: { fontSize: 9, fontFamily: "Helvetica-Bold", color: NAVY, textAlign: "center" },
  jSub: { fontSize: 6.8, color: GREY, textAlign: "center", marginTop: 2, lineHeight: 1.25 },
  jChevron: { width: 13, alignItems: "center", justifyContent: "center", paddingTop: 12 },

  areaCard: { borderWidth: 0.75, borderColor: RULE, borderRadius: 3, padding: 10, marginBottom: 8 },
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
function SketchView({ sketch }: { sketch: Sketch }) {
  return (
    <View style={s.sketchWrap} wrap={false}>
      <View style={s.sketchRow}>
        {sketch.boxes.map((b, i) => (
          <Text key={i} style={[s.sketchBox, { flex: 1 }, i === sketch.arrowAt ? s.sketchBoxOn : {}]}>
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
        {sketch.arrowAt > 0 && <View style={{ flex: sketch.arrowAt }} />}
        <View style={{ flex: sketch.boxes.length - sketch.arrowAt, flexDirection: "row", alignItems: "flex-start" }}>
          <View style={{ paddingTop: 1 }}>
            <Triangle dir="up" />
          </View>
          <Text style={[s.arrowLabel, { flex: 1 }]}>{pdfSafe(sketch.arrowLabel)}</Text>
        </View>
      </View>
    </View>
  );
}

function TaskView({ task }: { task: Task }) {
  return (
    <View style={s.task} wrap={false}>
      <Text style={s.taskTitle}>{pdfSafe(task.title)}</Text>
      <Text style={s.taskPath}>{pdfSafe(task.path)}</Text>
      {task.sketch && <SketchView sketch={task.sketch} />}
      {task.steps.map((st) => (
        <View key={st.n} style={s.step}>
          <Text style={s.stepNum}>{st.n}</Text>
          <Text style={s.stepText}>{pdfSafe(st.text)}</Text>
        </View>
      ))}
      {task.watchOut && (
        <View style={s.watchBox}>
          <View style={{ flex: 1 }}>
            <Text style={s.watchLabel}>Watch out</Text>
            <Text style={s.watchText}>{pdfSafe(task.watchOut)}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

function SectionPage({ section, company }: { section: Section; company: string }) {
  return (
    <Page size="LETTER" style={s.page}>
      <RunningHeader company={company} title={section.title} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={s.h1}>{section.title}</Text>
        <Text style={s.whoChip}>{section.who}</Text>
      </View>
      <Text style={s.intro}>{pdfSafe(section.intro)}</Text>

      {section.table && (
        <View>
          <View style={s.tHead}>
            <Text style={[s.th, { width: "30%" }]}>{section.table.head[0]}</Text>
            <Text style={[s.th, { width: "70%" }]}>{section.table.head[1]}</Text>
          </View>
          {section.table.rows.map(([k, v], i) => {
            // The "— More —" row is a divider, not a tab. Shaded so the reader
            // sees where the visible bar stops and the folded ones begin.
            const divider = k.startsWith("—");
            return (
              <View key={i} style={divider ? s.trDivider : s.tr}>
                <Text style={[s.cKey, divider ? { color: GREY } : {}]}>{pdfSafe(k)}</Text>
                <Text style={[s.cVal, divider ? { fontStyle: "italic", color: GREY } : {}]}>{pdfSafe(v)}</Text>
              </View>
            );
          })}
        </View>
      )}

      {section.tasks.map((t, i) => (
        <TaskView key={i} task={t} />
      ))}

      {section.footnote && <Text style={s.footnote}>{pdfSafe(section.footnote)}</Text>}
      <Footer company={company} />
    </Page>
  );
}

function GuideDoc({ company, logo }: { company: string; logo: Buffer | null }) {
  return (
    <Document title={`${company} — Running Commercial Work`} author={company}>
      {/* ── Cover ── */}
      <Page size="LETTER" style={s.cover}>
        {logo ? <Image src={logo} style={s.logoImageBig} /> : <Text style={s.wordmark}>{company}</Text>}
        <Text style={s.coverTitle}>Running Commercial Work</Text>
        <Text style={s.coverSub}>
          How to do everything in the Commercial Command Center{"\n"}— where each job lives, and who does what.
        </Text>
        <View style={s.coverRule} />
        <Text style={s.coverMeta}>{fmtToday().toUpperCase()}</Text>
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
        {AREAS.map((a) => (
          <View key={a.name} style={s.areaCard} wrap={false}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
              <Text style={s.areaName}>{a.name}</Text>
              <Text style={s.areaWho}>{a.who}</Text>
            </View>
            <Text style={s.areaHolds}>{pdfSafe(a.holds)}</Text>
          </View>
        ))}
        <Text style={s.footnote}>
          Stuck? Press Ask at the bottom right of any page and type the question in your own words. It will tell you
          where to go and take you there.
        </Text>
        <Footer company={company} />
      </Page>

      {/* ── One page per section ── */}
      {SECTIONS.map((section, i) => (
        <SectionPage key={i} section={section} company={company} />
      ))}

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
