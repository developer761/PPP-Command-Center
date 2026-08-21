import type { OperatingCompany } from "@/lib/commercial/operating-company/db";
import "server-only";

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
  renderToBuffer,
  Font,
  Svg,
  Circle,
} from "@react-pdf/renderer";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProposalTaxLine } from "./proposal-tax";
import {
  TOMCO_COMPANY_FOOTER,
  tomcoDefaultIntro,
  proposalTotalLabel,
  proposalRevisionLabel,
} from "./constants";
import { productUnitLabel } from "@/lib/commercial/products/constants";
import type {
  CommercialProposal,
  CommercialProposalLineItem,
  ProposalEstimatorSnapshot,
  ProposalHeaderJson,
} from "./db";

/**
 * Proposal PDF — react-pdf rendition matching Tomco's format extracted from
 * 5 real 2026 proposals (Rodeo, Prime Place, Water Lilies, Microchip,
 * Brinkmann's). Verbatim intro paragraph + ● glyph bullets + red keyline
 * border + Times serif.
 *
 * Two modes:
 * - "customer" (default): narrative bullets, single TOTAL, no per-line prices
 *   — matches how Tomco has always sent proposals to GCs.
 * - "internal": line-item table with per-row prices for Alex/Katie to
 *   verify the estimator math before Send.
 *
 * Called from /api/commercial/proposals/[proposalId]/pdf via dynamic import
 * so @react-pdf/renderer (~3-4 MB) stays out of every other bundle.
 */

Font.registerHyphenationCallback((word) => [word]);

// Karan 2026-07-17: Tomco logo from Alex. Cached at module load — read
// the file once, reuse the Buffer on every render. If the file goes
// missing (dev env without the asset, or bad deploy), fall back to the
// text wordmark gracefully so PDF rendering never crashes.
let cachedLogoBuffer: Buffer | null | undefined = undefined;
function getLogoBuffer(): Buffer | null {
  if (cachedLogoBuffer !== undefined) return cachedLogoBuffer;
  try {
    cachedLogoBuffer = readFileSync(
      join(process.cwd(), "public", "brand", "tomco-logo.jpg")
    );
    return cachedLogoBuffer;
  } catch (err) {
    console.warn(
      "[proposal-pdf] tomco-logo.jpg not found in public/brand/ — falling back to text wordmark:",
      err instanceof Error ? err.message : String(err)
    );
    cachedLogoBuffer = null;
    return null;
  }
}

const RED = "#B91C1C"; // Tomco brand red — matches cc-brand-700
const CHARCOAL = "#1F2937";
const MUTED = "#4B5563";
const YELLOW_BG = "#FEF3C7";
const YELLOW_BORDER = "#F59E0B";
const LINK_BLUE = "#1D4ED8";
// Karan 2026-07-21: subtle paper texture re-added per note "add texture
// to the proposal". CRITICAL LESSON from 3 prior rejections: every warm
// tone (F7F0DC cream, F5EFDE ivory) read as "too yellow". This version is
// strictly NEUTRAL — a barely-perceptible cool off-white base (#FCFCFC,
// no warm hue) + an ultra-faint neutral-GRAY fine-grain speckle at 2-4%
// opacity (see <PaperTexture/>). Reads as "real paper tooth", never
// yellow. Fully reversible: set PAPER_BG back to #FFFFFF and drop
// <PaperTexture/> from <Page> to return to pure white.
const PAPER_BG = "#FCFCFC";

// Deterministic speckle field — generated once at module load with a
// fixed-seed LCG so every render of every proposal gets the identical
// texture (no Math.random → reproducible PDFs). Neutral gray dots only.
const PAPER_SPECKS: { cx: number; cy: number; r: number; o: number }[] = (() => {
  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const out: { cx: number; cy: number; r: number; o: number }[] = [];
  // LETTER = 612 × 792 pt. ~150 tiny dots reads as fine paper tooth
  // without ever looking like noise or dirt on a client bid.
  for (let i = 0; i < 150; i++) {
    out.push({
      cx: Math.round(rand() * 612 * 10) / 10,
      cy: Math.round(rand() * 792 * 10) / 10,
      r: Math.round((0.35 + rand() * 0.45) * 100) / 100,
      o: Math.round((0.02 + rand() * 0.02) * 1000) / 1000,
    });
  }
  return out;
})();

/**
 * Full-page neutral paper texture. Absolutely positioned + `fixed` so it
 * repeats on every page and sits BEHIND the flowing content (rendered as
 * the first child of <Page>). Gray-only, very low opacity — provides
 * "paper tooth" feel with zero warm/yellow cast.
 */
function PaperTexture() {
  return (
    <Svg
      fixed
      style={{ position: "absolute", top: 0, left: 0, width: 612, height: 792 }}
      viewBox="0 0 612 792"
    >
      {PAPER_SPECKS.map((s, i) => (
        <Circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill="#4b5563" opacity={s.o} />
      ))}
    </Svg>
  );
}

const styles = StyleSheet.create({
  page: {
    // Karan 2026-07-19 (round 3.1 1:1): must fit everything on ONE
    // page like reference. paddingTop 92 → 82, lineHeight tightened
    // 1.4 → 1.3 to keep body compact while section spacing stays
    // generous. Side padding stays 52 (matches reference proportions).
    paddingTop: 82,
    paddingHorizontal: 52,
    paddingBottom: 96,
    fontSize: 11,
    fontFamily: "Times-Roman",
    color: CHARCOAL,
    lineHeight: 1.3,
    backgroundColor: PAPER_BG,
  },
  // Karan 2026-07-19 (round 2): single red keyline border, tighter to
  // paper edge (matches reference PDF proportions — narrower outer
  // white margin, larger content area).
  borderFrame: {
    position: "absolute",
    top: 18,
    left: 22,
    right: 22,
    bottom: 82,
    borderStyle: "solid",
    borderWidth: 1.5,
    borderColor: RED,
  },
  // Karan 2026-07-19 (round 2 1:1): logo sits at the very top of the
  // page and visually straddles the red border top line (matches
  // reference PDF letterhead where "PAINTING" red bar merges with
  // the border). Absolutely positioned so it doesn't push content
  // down.
  headerRow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 60,
  },
  logoDashLeft: {
    flex: 1,
    borderBottomWidth: 1.5,
    borderBottomColor: RED,
    borderStyle: "dashed",
    marginRight: 8,
    height: 1,
  },
  logoDashRight: {
    flex: 1,
    borderBottomWidth: 1.5,
    borderBottomColor: RED,
    borderStyle: "dashed",
    marginLeft: 8,
    height: 1,
  },
  logoBlock: {
    flexDirection: "column",
    alignItems: "center",
  },
  // Karan 2026-07-19 (Katie feedback: "PAINTING looks squished"):
  // enlarged logo from 150×73 → 190×93 so the PAINTING red banner
  // reads at proper proportion instead of feeling compressed. Source
  // is 268×131px (ratio 2.046); new dimensions preserve aspect
  // exactly (190/93 = 2.043). objectFit contain still preserves
  // aspect if the container is off.
  logoImage: {
    width: 190,
    height: 93,
    objectFit: "contain",
  },
  logoText: {
    fontSize: 34,
    fontFamily: "Times-Bold",
    color: RED,
    letterSpacing: 4,
    lineHeight: 1,
  },
  logoSub: {
    fontSize: 9,
    color: RED,
    letterSpacing: 6,
    marginTop: 3,
    fontFamily: "Times-Bold",
  },
  dateFloat: {
    // Karan 2026-07-19 (round 3 1:1): moved date down from top:46 to
    // top:78 so it sits well INSIDE the border top (border top = 18)
    // with real breathing room, matching reference. Reference has
    // date at roughly the same vertical position as the logo bottom.
    position: "absolute",
    top: 78,
    right: 54,
    fontSize: 11,
    color: CHARCOAL,
    fontFamily: "Times-Bold",
    textAlign: "right",
  },
  dateNumber: {
    position: "absolute",
    top: 94,
    right: 54,
    fontSize: 11,
    color: CHARCOAL,
    fontFamily: "Times-Bold",
    textAlign: "right",
  },
  dateText: {
    fontSize: 12,
    color: CHARCOAL,
    fontFamily: "Times-Bold",
    minWidth: 90,
    textAlign: "right",
  },
  sectionUnderlineHeader: {
    // Karan 2026-07-19 (round 3.1 1:1): section headers have real
    // breathing room above but tuned so full content fits on one page.
    // 20 → 14 for section headers; still visibly separated but not
    // pushing content off.
    fontSize: 11,
    fontFamily: "Times-Bold",
    textDecoration: "underline",
    marginTop: 14,
    marginBottom: 5,
  },
  addrBlock: {
    marginLeft: 22,
    marginTop: 6,
  },
  addrLine: {
    fontSize: 11,
    color: CHARCOAL,
    fontFamily: "Times-Bold",
  },
  gcName: {
    fontSize: 11,
    fontFamily: "Times-Bold",
  },
  link: {
    color: LINK_BLUE,
    textDecoration: "underline",
  },
  intro: {
    // Karan 2026-07-19 (round 3.1 1:1): tighter to fit on one page.
    marginTop: 14,
    marginBottom: 12,
    fontSize: 11,
    // Karan 2026-07-19 (round 2 1:1 verify): reference PDF renders the
    // intro paragraph in Times-Bold. Rendered the reference to PNG
    // and confirmed side-by-side — the "Tomco is pleased to
    // provide..." line is clearly bold weight. Prior 2026-07-15 switch
    // to Times-Roman was based on a bad memory of "too bold" — the
    // reference proves otherwise.
    fontFamily: "Times-Bold",
    lineHeight: 1.4,
  },
  bulletRow: {
    flexDirection: "row",
    marginBottom: 3,
    paddingRight: 4,
    alignItems: "flex-start",
  },
  // Karan 2026-07-19 (round 2 1:1): reference bullets are large filled
  // black circles clearly visible next to Exclusions items. Bumped
  // from 3pt (barely visible in the render) to 5pt to match the
  // reference weight. Kept as View not glyph so it works across
  // any font.
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: CHARCOAL,
    marginTop: 5,
    marginLeft: 4,
    marginRight: 10,
  },
  bulletBody: {
    flex: 1,
    fontSize: 11,
  },
  // Brendan 2026-08-17: a ticked line shows its price and nothing else — no
  // unit price, no unit, no quantity. Right-aligned so a column of them reads
  // cleanly against the single TOTAL below.
  inlinePrice: {
    fontSize: 11,
    fontFamily: "Times-Bold",
    marginLeft: 8,
    textAlign: "right",
    minWidth: 66,
  },
  bulletLead: {
    fontFamily: "Times-Bold",
  },
  bulletSubRow: {
    flexDirection: "row",
    marginBottom: 2,
    marginLeft: 18,
    paddingRight: 4,
    alignItems: "flex-start",
  },
  bulletSubDot: {
    width: 2.5,
    height: 2.5,
    borderRadius: 1.25,
    backgroundColor: MUTED,
    marginTop: 6,
    marginRight: 7,
  },
  bulletSubBody: {
    flex: 1,
    fontSize: 11,
  },
  // Tomco line-item convention (from reference PDF): plain lines with a
  // bold colon-terminated label, no bullet glyph. e.g.
  //   Foyer Walls: Prep, prime, and paint 2 coats
  itemLine: {
    // Karan 2026-07-19 (round 3 1:1): tighter line spacing between
    // scope items (reference has single-line spacing). Bumped 6 → 4
    // so items sit closer together like reference.
    marginBottom: 4,
    fontSize: 11,
  },
  totalRow: {
    // Karan 2026-07-19 (round 3.1 1:1): reference has visible space
    // above TOTAL but not enormous — 22 keeps it clearly separated
    // from Exclusions bullets while leaving room for Estimator on
    // page 1.
    marginTop: 22,
    marginBottom: 6,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  totalText: {
    fontSize: 13,
    fontFamily: "Times-Bold",
  },
  altSection: {
    marginTop: 12,
  },
  altHeader: {
    fontSize: 11,
    fontFamily: "Times-Bold",
    textDecoration: "underline",
    marginBottom: 4,
  },
  altAmount: {
    fontSize: 11,
    fontFamily: "Times-Bold",
    marginTop: 4,
    textAlign: "right",
  },
  // Yellow-highlighted CI line — Tomco uses an inline text highlight,
  // NOT a left-border banner. Matches reference PDF exactly.
  ciWrap: {
    marginTop: 18,
    marginBottom: 2,
  },
  ciText: {
    fontFamily: "Times-Bold",
    fontSize: 11,
    backgroundColor: YELLOW_BG,
  },
  signBlock: {
    marginTop: 4,
    fontSize: 11,
  },
  signHeading: {
    fontFamily: "Times-Bold",
    marginBottom: 14,
  },
  taxLine: {
    fontSize: 11,
    lineHeight: 1.5,
  },
  signContact: {
    marginTop: 18,
  },
  signContactName: {
    fontFamily: "Times-Bold",
    fontSize: 11,
  },
  signContactRow: {
    fontSize: 11,
    lineHeight: 1.35,
  },
  signLine: {
    fontFamily: "Times-Bold",
    marginTop: 14,
  },
  estBlock: {
    marginTop: 20,
    fontSize: 11,
  },
  // Karan 2026-07-17 (Katie feedback): match reference PDF — "Estimator:"
  // is a bold+underlined header, then the name / phone / email lines are
  // each bold + underlined. Prior version had only the name bold and no
  // header at all.
  estHeader: {
    fontFamily: "Times-Bold",
    textDecoration: "underline",
    fontSize: 11,
    marginBottom: 2,
  },
  estName: {
    fontFamily: "Times-Bold",
    textDecoration: "underline",
    fontSize: 11,
    marginBottom: 1,
  },
  estRow: {
    color: CHARCOAL,
    fontFamily: "Times-Bold",
    textDecoration: "underline",
    fontSize: 11,
    marginBottom: 1,
  },
  // Karan 2026-07-17 (Katie feedback: footer clipping + match reference):
  // footer sits well inside the red keyline border, single centered line
  // "77-13 Windsor Place • Central Islip, NY 11722 • Tel: 631.582.2770 •
  // Fax: 631.582.2771 • Web: www.tomcopainting.com" with Tel/Fax/Web
  // labels rendered in RED bold to match the reference PDF letterhead.
  // Positioned at bottom 60 so it's inside the border (bottom 92) with
  // ~30pt clearance — no more clip risk.
  footerRow: {
    position: "absolute",
    left: 40,
    right: 40,
    bottom: 60,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  footerRuleFlank: {
    // Short red rule flanks on either side of the footer text — visually
    // matches the reference PDF's letterhead footer ("— … —").
    width: 18,
    height: 0.75,
    backgroundColor: RED,
  },
  footerText: {
    fontSize: 8,
    color: CHARCOAL,
    textAlign: "center",
  },
  footerLabel: {
    color: RED,
    fontFamily: "Times-Bold",
  },
  pageNumber: {
    position: "absolute",
    right: 48,
    bottom: 42,
    fontSize: 8,
    color: MUTED,
  },
  // Internal-mode line-item table
  liTable: {
    marginTop: 8,
    marginBottom: 6,
    borderTopWidth: 0.5,
    borderTopColor: CHARCOAL,
  },
  liHeaderRow: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: CHARCOAL,
  },
  liRow: {
    flexDirection: "row",
    paddingVertical: 3,
    borderBottomWidth: 0.25,
    borderBottomColor: "#D1D5DB",
  },
  liHeaderCell: {
    fontFamily: "Times-Bold",
    fontSize: 9,
    color: CHARCOAL,
  },
  liCell: {
    fontSize: 9,
    color: CHARCOAL,
  },
  liCellDesc: {
    flex: 4,
    paddingRight: 6,
  },
  liCellQty: {
    flex: 1,
    textAlign: "right",
    paddingRight: 6,
  },
  liCellUnit: {
    flex: 1,
    textAlign: "left",
    paddingRight: 6,
  },
  liCellPrice: {
    flex: 1,
    textAlign: "right",
    paddingRight: 6,
  },
  liCellLine: {
    flex: 1.2,
    textAlign: "right",
  },
  // Phase grouping in the priced table (Katie: "group products + pricing by
  // Phase"). A bold phase header row above each group + a subtotal row below.
  liPhaseHeader: {
    paddingTop: 7,
    paddingBottom: 2,
  },
  liPhaseHeaderText: {
    fontFamily: "Times-Bold",
    fontSize: 9.5,
    color: CHARCOAL,
  },
  liSubtotalRow: {
    flexDirection: "row",
    paddingTop: 3,
    paddingBottom: 5,
    borderTopWidth: 0.5,
    borderTopColor: "#9CA3AF",
  },
  liSubtotalLabel: {
    flex: 7,
    textAlign: "right",
    paddingRight: 6,
    fontFamily: "Times-Bold",
    fontSize: 9,
    color: CHARCOAL,
  },
  liSubtotalAmount: {
    flex: 1.2,
    textAlign: "right",
    fontFamily: "Times-Bold",
    fontSize: 9,
    color: CHARCOAL,
  },
});

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateLong(iso: string | undefined): string {
  if (!iso) return "";
  // date_iso is a bare YYYY-MM-DD string — parse as local calendar
  // date (no TZ shift) then format long.
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  // Round-3 audit fix: reject out-of-range month/day so a malformed
  // input like "2026-15-45" doesn't silently roll over via JS Date to
  // "March 15, 2027". Show the raw ISO instead so Alex sees the bad
  // input and can fix it in the editor.
  if (m < 1 || m > 12 || d < 1 || d > 31) return iso;
  const dt = new Date(y, m - 1, d);
  // Round-trip check: if JS rolled over (e.g., Feb 30), it means the
  // day was invalid for that month. Show raw ISO to avoid confusion.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return iso;
  }
  return dt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Collapse tabs / runs of spaces to a single space; preserve newlines.
 *  Applied before splitBoldLead so descriptions like "Install\tlabor
 *  priced by square foot" render clean on the PDF instead of "Install
 *  \tlabor…" or wide gaps. */
function normalizeWs(s: string): string {
  return transliterateToWinAnsi(s).replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/**
 * Map characters that WinAnsiEncoding can't represent onto ones it can.
 *
 * These PDFs render in the standard-14 fonts, which @react-pdf/pdfkit embeds
 * as WinAnsi. A code point outside that map is emitted raw, so it prints as a
 * stray symbol rather than the character typed — U+2212 MINUS came out as `"`.
 * Scope text is pasted straight from GC specs, where prime/double-prime marks
 * (6′ 6″), non-breaking hyphens and math symbols are routine, so sanitize here
 * rather than waiting to be told a proposal printed garbage.
 */
export function transliterateToWinAnsi(s: string): string {
  return s
    .replace(/−/g, "-") // minus sign
    .replace(/[′‵]/g, "'") // prime / reversed prime  → foot mark
    .replace(/[″‶]/g, '"') // double prime            → inch mark
    .replace(/[‑‐]/g, "-") // non-breaking / plain hyphen
    .replace(/⁄/g, "/") // fraction slash
    .replace(/ /g, " ") // non-breaking space
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/×/g, "x")
    .replace(/≈/g, "~");
}

/** Split "**Bold lead:** rest of the sentence." into the two parts so we
 *  can render the lead in Times-Bold and the rest in Times-Roman.
 *  Tomco's convention is a single colon-terminated bold lead, e.g.
 *  "GWB Ceiling & Soffit:" or "Doors and Frames:". Reject sentence-medial
 *  colons — "This is a very long clause: continues past" should NOT split. */
function splitBoldLead(text: string): { lead: string | null; body: string } {
  const trimmed = normalizeWs(text);
  // Explicit **bold** wrapper first (markdown-style) — always trust it,
  // bypasses the length + word-count heuristic below. Used by the
  // ProductPicker when seeding descriptions for parent+variation picks
  // ("**Wallcovering Install (Per Square Foot):** Install labor…").
  //
  // Bug fix 2026-07-20: strip trailing colon from the captured lead
  // BEFORE render appends its own `:`. Prior code returned lead with
  // the colon in it, so render printed "Lead::" (double colon).
  const md = /^\*\*(.+?)\*\*[:：]?\s*(.*)$/.exec(trimmed);
  if (md) {
    return { lead: md[1].trim().replace(/[:：]+\s*$/, ""), body: md[2].trim() };
  }
  // Bare "Lead: body" — only accept when the lead is short (<30 chars)
  // AND ≤5 whitespace-delimited words. That rejects long clauses like
  // "This is a very long clause:" while still catching Tomco item names
  // like "Doors and Frames:" or "GWB Ceiling & Soffit:".
  const colon = trimmed.indexOf(":");
  if (colon > 0 && colon < 30) {
    const lead = trimmed.slice(0, colon).trim();
    if (lead.split(/\s+/).length <= 5) {
      return { lead, body: trimmed.slice(colon + 1).trim() };
    }
  }
  return { lead: null, body: trimmed };
}

// ─── Sub-blocks ─────────────────────────────────────────────────────

function LogoBlock({
  dateLabel,
  dealNumber,
}: {
  dateLabel: string;
  dealNumber: string | null;
}) {
  // Karan 2026-07-17: real Tomco logo image from Alex, cached at module
  // load. If the file is missing (dev without asset, deploy hiccup),
  // fall back to the text wordmark so the PDF still renders — never
  // crash a customer-facing send on a missing asset.
  //
  // Karan 2026-07-20 (Phase G Q1): restored the "No. ALT-0125" line
  // under the date, now sourced from opp.deal_number (per-account
  // sequential, matches Tomco's JD Sports reference "No. ALT0125"
  // convention). Only renders when the header carries a real deal
  // number — legacy proposals with no deal_number show only the date.
  const logo = getLogoBuffer();
  return (
    <>
      <View style={styles.headerRow}>
        {logo ? (
          <Image src={logo} style={styles.logoImage} />
        ) : (
          <View style={styles.logoBlock}>
            <Text style={styles.logoText}>TOMCO</Text>
            <Text style={styles.logoSub}>PAINTING</Text>
          </View>
        )}
      </View>
      {dateLabel && <Text style={styles.dateFloat}>{dateLabel}</Text>}
      {dealNumber && <Text style={styles.dateNumber}>No. {dealNumber}</Text>}
    </>
  );
}

function SubmittedToBlock({ h }: { h: ProposalHeaderJson }) {
  const hasAttentionBlock = Boolean(h.attention || h.title || h.phone || h.email);
  return (
    <View>
      <Text style={styles.sectionUnderlineHeader}>PROPOSAL SUBMITTED TO:</Text>
      {/* Company + address indented + bold (matches Tomco reference PDF). */}
      <View style={styles.addrBlock}>
        {h.gc_company && <Text style={styles.addrLine}>{h.gc_company}</Text>}
        {(h.gc_address_lines ?? []).map((line, i) => (
          <Text key={i} style={styles.addrLine}>{line}</Text>
        ))}
      </View>
      {/* Blank-line separator + Attention block, also indented + bold.
          Karan 2026-07-21: back to "Attn:" per Karan's written spec
          ("Attn: (Name)"). NOTE: this has flip-flopped — 2026-07-19 set it
          to "Attention:" to match the JD Sports reference PDF which spells
          it out. Karan's latest explicit note wins; confirm against
          Brendan's actual sample to lock it. Email = blue underlined link. */}
      {hasAttentionBlock && (
        <View style={[styles.addrBlock, { marginTop: 10 }]}>
          {h.attention && (
            <Text style={styles.addrLine}>Attention: {h.attention}</Text>
          )}
          {h.title && <Text style={styles.addrLine}>{h.title}</Text>}
          {h.phone && <Text style={styles.addrLine}>P: {h.phone}</Text>}
          {h.email && (
            <Text style={[styles.addrLine, styles.link]}>{h.email}</Text>
          )}
        </View>
      )}
    </View>
  );
}

function ProjectBlock({ h, revisionLabel }: { h: ProposalHeaderJson; revisionLabel?: string }) {
  // Brendan 2026-08-17: "it's important that we label it R1 on the customer
  // proposals. We typically put it right before the 'Tomco Office' on the
  // project line." So the label leads the project NAME, not the address:
  //   PROJECT: R1 Tomco Office, 123 Main Street, Bay Shore
  // Uses the shared proposalRevisionLabel, which stays empty until numbering
  // has started on the deal — an unsent first draft still prints no label.
  const rawName = h.project_name?.trim();
  const name = rawName && revisionLabel ? `${revisionLabel} ${rawName}` : rawName;
  const addr = h.project_address?.trim();
  if (!name && !addr) return null;
  // Tomco reference format is a single "PROJECT: Name, Address" line
  // (bold + underlined). Always inline unless the joined string would
  // wrap awkwardly on the header row (>90 chars).
  const joined = [name, addr].filter(Boolean).join(", ");
  const inline = joined.length <= 90;
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={styles.sectionUnderlineHeader}>
        PROJECT:{inline ? ` ${joined}` : ""}
      </Text>
      {!inline && (
        <View style={styles.addrBlock}>
          {name && <Text style={styles.addrLine}>{name}</Text>}
          {addr && <Text style={styles.addrLine}>{addr}</Text>}
        </View>
      )}
    </View>
  );
}

/** Tomco line-item format (verified against reference PDF): plain
 *  lines with a bold colon-terminated label and regular-weight body.
 *  Example: **Foyer Walls:** Prep, prime, and paint 2 coats
 *
 *  Multi-line descriptions (embedded newlines) or comma-separated
 *  sub-items after the bold lead are auto-bulleted as indented
 *  sub-lines under the lead. Karan 2026-07-15: "Gas Pipes: for
 *  these items X, Y, Z" reads much better as bulleted sub-items.
 *
 *  No top-level bullet glyph — Tomco's letterhead convention is plain
 *  lines with bold leads. */
/** Render one inclusion/alternate line.
 *  Migration 071: prefer the snapshotted `product_name` as the bold lead
 *  with the description below/next to it (Product + Description are now
 *  distinct). Legacy rows (product_name null) fall back to parsing a
 *  bold-lead out of the description, preserving how they were authored. */
function ItemLine({ item }: { item: CommercialProposalLineItem }) {
  const productName = item.product_name?.trim();
  // Brendan 2026-08-17: "when you click show line item price on the product it
  // doesn't show up… Just the price is good." The per-line checkbox used to
  // gate a cell in the itemized TABLE, which the default customer proposal
  // never renders — so it did nothing here. Now a ticked line prints its own
  // total inline, and ONLY the money: no unit price, no unit, no quantity.
  const priceText = item.show_price === true ? formatDollars(lineTotalCents(item)) : null;
  if (productName) {
    const raw = normalizeWs(item.description ?? "");
    const bodyLines = raw.includes("\n")
      ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : raw
      ? [raw]
      : [];
    return (
      // Katie 2026-08-13: "the bulleting formatting is weird on the proposal,
      // some lines are bulleted and others are not."
      //
      // Two inconsistencies, both here. Inclusions rendered with NO bullet
      // while Labor and Exclusions both got one — so a single PDF used two
      // grammars for the same kind of list. And within Inclusions, whether a
      // line got sub-bullets depended on whether its description happened to
      // contain a newline, which is a storage detail the reader can't see.
      //
      // Every scope line now leads with the same dot as every other list on
      // the page. Sub-bullets stay for a genuinely multi-line description,
      // because that IS a list — it is just no longer the only bulleted thing.
      <View style={styles.itemLine}>
        <View style={styles.bulletRow}>
          <View style={styles.bulletDot} />
          <Text style={styles.bulletBody}>
            <Text style={styles.bulletLead}>{productName}</Text>
            {bodyLines.length === 1 ? <Text>{" — " + bodyLines[0]}</Text> : null}
          </Text>
          {priceText && <Text style={styles.inlinePrice}>{priceText}</Text>}
        </View>
        {bodyLines.length > 1 &&
          bodyLines.map((sub, i) => (
            <View key={i} style={styles.bulletSubRow}>
              <View style={styles.bulletSubDot} />
              <Text style={styles.bulletSubBody}>{sub}</Text>
            </View>
          ))}
      </View>
    );
  }
  return <BulletLine text={item.description} price={priceText} />;
}

function BulletLine({ text, price }: { text: string; price?: string | null }) {
  const { lead, body } = splitBoldLead(text);
  // Split body by explicit newlines OR by ", " when there are ≥3
  // fragments (looks like a list of sub-items rather than a sentence
  // with commas). Single-comma bodies like "for the roof, per spec"
  // stay as a single line.
  const explicitNewlines = body.includes("\n");
  const bodyLines = explicitNewlines
    ? body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [body];
  const shouldBulletSubs = bodyLines.length > 1;
  if (lead) {
    // Lead-only line if body is empty; otherwise render lead + body
    // inline as usual. When there are multiple body lines, render the
    // first as inline and the rest as bulleted sub-lines.
    return (
      <View style={styles.itemLine}>
        <View style={styles.bulletRow}>
          <Text style={[styles.bulletBody, { fontSize: 11 }]}>
            <Text style={styles.bulletLead}>{lead}:</Text>
            {bodyLines[0] ? <Text>{" " + bodyLines[0]}</Text> : null}
          </Text>
          {price && <Text style={styles.inlinePrice}>{price}</Text>}
        </View>
        {shouldBulletSubs && bodyLines.slice(1).map((sub, i) => (
          <View key={i} style={styles.bulletSubRow}>
            <View style={styles.bulletSubDot} />
            <Text style={styles.bulletSubBody}>{sub}</Text>
          </View>
        ))}
      </View>
    );
  }
  // Karan 2026-07-17 (1:1 reference match): reference PDF has NO
  // bullet dots on inclusion items. Even items without a bold lead
  // render as plain lines. Bullets are reserved for the Exclusions &
  // Qualifications section only. Prior behavior added a dot to
  // dot-less items, which visually clashed with the reference.
  //
  // Multi-line body (embedded newlines) with no bold lead: render each
  // line as its own plain paragraph so line breaks the user typed
  // survive to the PDF. Prior single-Text render dropped multi-line
  // grammar for no-lead items.
  if (bodyLines.length > 1) {
    return (
      <View style={styles.itemLine}>
        {bodyLines.map((line, i) => (
          <View key={i} style={styles.bulletRow}>
            <Text style={[styles.bulletBody, { fontSize: 11 }]}>{line}</Text>
            {/* Price rides the LAST line so it lands level with the end of
                the item, not floating beside its first line. */}
            {price && i === bodyLines.length - 1 && (
              <Text style={styles.inlinePrice}>{price}</Text>
            )}
          </View>
        ))}
      </View>
    );
  }
  if (price) {
    return (
      <View style={[styles.itemLine, styles.bulletRow]}>
        <Text style={[styles.bulletBody, { fontSize: 11 }]}>{body}</Text>
        <Text style={styles.inlinePrice}>{price}</Text>
      </View>
    );
  }
  return <Text style={styles.itemLine}>{body}</Text>;
}

type PhaseGroup = { key: string; label: string; rows: CommercialProposalLineItem[] };
const UNGROUPED_PHASE_KEY = "__ungrouped__";
/**
 * Group line items by phase (Katie F.6 / 2026-07-28 pricing-by-phase). The
 * grouping is normalized (lowercased + internal whitespace collapsed) so
 * "Phase 1" / "phase 1" / "Phase  1" merge into ONE group; the DISPLAY label
 * keeps the first-seen spelling. Ungrouped (no phase) rows collect under a
 * "General" sentinel and sort to the front. Shared by BOTH the customer bullet
 * view and the priced table so the two never group differently.
 */
function groupItemsByPhase(items: CommercialProposalLineItem[]): {
  anyHasPhase: boolean;
  groups: PhaseGroup[];
} {
  const anyHasPhase = items.some((it) => it.phase && it.phase.trim());
  const groups: PhaseGroup[] = [];
  const byKey = new Map<string, PhaseGroup>();
  for (const it of items) {
    const raw = it.phase?.trim();
    const key = raw ? raw.toLowerCase().replace(/\s+/g, " ") : UNGROUPED_PHASE_KEY;
    const label = raw || "General";
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(it);
  }
  // If a real phase is literally named "General" (any case), the ungrouped
  // sentinel would DISPLAY the same "General" label → the reader sees two
  // "General" sections + two "General subtotal" lines (keys differ, so the math
  // is still correct — this is display-only). Relabel the sentinel so they're
  // visually distinct.
  const ungrouped = byKey.get(UNGROUPED_PHASE_KEY);
  if (ungrouped && byKey.has("general")) {
    ungrouped.label = "Unphased";
  }
  groups.sort((a, b) => (a.key === UNGROUPED_PHASE_KEY ? -1 : b.key === UNGROUPED_PHASE_KEY ? 1 : 0));
  return { anyHasPhase, groups };
}

/** Line total in cents — the ONE definition, so per-line, per-phase-subtotal,
 *  and grand-total all round identically and reconcile to the penny. */
function lineTotalCents(it: CommercialProposalLineItem): number {
  // An explicit override wins over qty x unit price, so an estimator can
  // discount or uplift a line without faking the quantity (Brendan 2026-08-17).
  // This is the single definition — per-line, per-phase subtotal and the grand
  // total all route through it, so an override can never desync them.
  const ov = it.line_total_override_cents;
  if (ov !== null && ov !== undefined && Number.isFinite(Number(ov))) {
    return Math.round(Number(ov));
  }
  return Math.round(Number(it.quantity) * it.unit_price_cents);
}

function InclusionsCustomer({
  items,
  laborItems = [],
  hideLaborPrices = false,
}: {
  items: CommercialProposalLineItem[];
  /** Karan 2026-08: "Move the Labor into Inclusions." Labor used to print as
   *  its own section between Scope and Alternates, which read to the client as
   *  a separate charge rather than part of the work being proposed. It now
   *  renders inside Scope of Work, after the material lines:
   *    Custom Time  → "description — 12 hrs @ $85.00/hr = $1,020.00"
   *    Materials    → the flat line price (unchanged ItemLine rendering)
   *  Same rows, same TOTAL — only where they sit on the page changes. */
  laborItems?: CommercialProposalLineItem[];
  /** A final-price override is active, so per-line labor money would
   *  contradict the reconciled TOTAL — drop the rate tail. */
  hideLaborPrices?: boolean;
}) {
  if (items.length === 0 && laborItems.length === 0) return null;
  const laborLines = laborItems.map((it) => {
    const subtotal = Math.round(Number(it.quantity) * it.unit_price_cents);
    const hrs = Number(it.quantity);
    const rate = it.unit_price_cents / 100;
    const priceTail =
      it.show_price === false || hideLaborPrices
        ? ""
        : ` @ $${rate.toFixed(2)}/hr = $${(subtotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return (
      <View key={it.id} style={styles.bulletRow}>
        <View style={styles.bulletDot} />
        <Text style={styles.bulletBody}>
          {it.description} — {hrs} {hrs === 1 ? "hr" : "hrs"}{priceTail}
        </Text>
      </View>
    );
  });
  // Karan 2026-07-20: reference PDF flows scope straight after the
  // intro, but our proposals mix inclusions + labor + exclusions and
  // Alex asked for section headings so each block is unmistakably
  // delineated. Adds an underlined "Scope of Work:" heading above
  // inclusions (matches the "Exclusions:" + "Labor:" heading style).
  //
  // F.6 (2026-07-19): Katie's ask — group by phase when any line item
  // has a phase set. If NONE do, fall back to flat rendering (backward
  // compat with every existing proposal). Phase-null items when some
  // items DO have phases collect under a "General" section at the top.
  const { anyHasPhase, groups } = groupItemsByPhase(items);
  if (!anyHasPhase) {
    return (
      <View style={{ marginTop: 14 }}>
        {/* Stephanie 2026-08-20: "Inclusions, scope of work, change all PDF's
            to read one or the other." Tomco's own Work Order heads this
            section "Inclusions:", and the internal proposal view and the work
            order both already say it — so the customer proposal was the only
            document using the other word. */}
        <Text style={styles.sectionUnderlineHeader}>Inclusions:</Text>
        <View style={{ marginTop: 4 }}>
          {items.map((it) => (
            <ItemLine key={it.id} item={it} />
          ))}
          {laborLines}
        </View>
      </View>
    );
  }
  // Phase-grouped branch below appends the labor lines after the last phase —
  // labor spans phases, so it reads as the closing part of the scope rather
  // than being arbitrarily filed under one of them.
  // F.6 audit fix: don't wrap={false} the whole group — a phase with
  // 30+ line items would refuse to break across pages and overflow.
  // Instead, keep just the section header + FIRST row atomic (so a
  // header never orphans at the bottom of a page), then let subsequent
  // rows flow normally.
  return (
    <View style={{ marginTop: 4 }}>
      {groups.map((g) => {
        const [firstRow, ...restRows] = g.rows;
        return (
          <View key={g.key} style={{ marginTop: 6 }}>
            <View wrap={false}>
              <Text style={styles.sectionUnderlineHeader}>{g.label}:</Text>
              {firstRow && <ItemLine item={firstRow} />}
            </View>
            {restRows.map((it) => (
              <ItemLine key={it.id} item={it} />
            ))}
          </View>
        );
      })}
      {laborLines.length > 0 && (
        <View style={{ marginTop: 6 }}>{laborLines}</View>
      )}
    </View>
  );
}

function LiRow({
  it,
  showAlternateBadge,
  respectShowPrice = false,
  priceOnly = false,
}: {
  it: CommercialProposalLineItem;
  showAlternateBadge: boolean;
  /** The per-line "show price" control is in use on this proposal, so a line
   *  that was left unticked prints without its money. */
  respectShowPrice?: boolean;
  /** Brendan 2026-08-17, on the customer copy with per-line prices turned on:
   *  "it shows also the unit price and the unit and quantity. We don't want
   *  that. Just the price is good." So the CUSTOMER table is description +
   *  line total. The internal copy keeps qty / unit / unit price, because
   *  checking that math is the whole reason the internal copy exists. */
  priceOnly?: boolean;
}) {
  const hidePrice = priceOnly && respectShowPrice === true && it.show_price === false;
  return (
    <View style={styles.liRow}>
      <Text style={[styles.liCell, styles.liCellDesc]}>
        {showAlternateBadge && it.is_alternate ? "[ALT] " : ""}
        {it.product_name ? (
          <Text style={{ fontFamily: "Times-Bold" }}>
            {it.product_name}
            {it.description ? " — " : ""}
          </Text>
        ) : null}
        {it.description}
      </Text>
      {!priceOnly && (
        <>
          <Text style={[styles.liCell, styles.liCellQty]}>{it.quantity}</Text>
          <Text style={[styles.liCell, styles.liCellUnit]}>{productUnitLabel(it.unit)}</Text>
        </>
      )}
      {!priceOnly && (
        <Text style={[styles.liCell, styles.liCellPrice]}>{formatDollars(it.unit_price_cents)}</Text>
      )}
      {/* Stephanie 2026-08-17: "There is an option to show price per line, but
          it shows price per line regardless of whether that is chosen or not."

          True, and deliberately so until now: migration 148 backfilled
          show_price to FALSE on every existing line and flipped the default to
          FALSE, because it means "opt this line's price into the BULLETED
          customer proposal". Reading it here would have blanked every cell of
          the itemized table instead.

          So it is honoured only when the control is actually in use — i.e.
          when at least one line on this proposal has been ticked. Nobody
          ticking anything still prints every price, which is what turning the
          itemized table on means. Tick some, and the unticked ones go blank:
          the checkbox does what it says. */}
      {hidePrice ? (
        <Text style={[styles.liCell, styles.liCellLine]}> </Text>
      ) : (
        <Text style={[styles.liCell, styles.liCellLine]}>{formatDollars(lineTotalCents(it))}</Text>
      )}
    </View>
  );
}

function LineItemTable({
  items,
  showAlternateBadge,
  groupByPhase = false,
  priceOnly = false,
  respectShowPrice = false,
  scopeTotalLabel,
}: {
  items: CommercialProposalLineItem[];
  showAlternateBadge: boolean;
  /** See LiRow — the per-line price checkbox is in use on this proposal. */
  respectShowPrice?: boolean;
  /** Stephanie 2026-08-20: "On the price per item customer PDF we need to add
   *  a total to the main scope only." A closing subtotal under the base scope
   *  rows — alternates deliberately get none, since they are options the
   *  customer has not bought and summing them reads as part of the price. */
  scopeTotalLabel?: string;
  /** Customer copy: description + price, nothing else (Brendan 2026-08-17). */
  priceOnly?: boolean;
  /** Katie 2026-07-28: group the priced table by phase with a per-phase
   *  subtotal. Only the base inclusions table sets this (not labor/alternates).
   *  Falls back to a flat table when no line item carries a phase. */
  groupByPhase?: boolean;
}) {
  const grouping = groupByPhase
    ? groupItemsByPhase(items)
    : { anyHasPhase: false, groups: [] as PhaseGroup[] };
  const header = (
    <View style={styles.liHeaderRow} fixed>
      <Text style={[styles.liHeaderCell, styles.liCellDesc]}>Description</Text>
      {!priceOnly && (
        <>
          <Text style={[styles.liHeaderCell, styles.liCellQty]}>Qty</Text>
          <Text style={[styles.liHeaderCell, styles.liCellUnit]}>Unit</Text>
          <Text style={[styles.liHeaderCell, styles.liCellPrice]}>Unit price</Text>
        </>
      )}
      <Text style={[styles.liHeaderCell, styles.liCellLine]}>
        {priceOnly ? "Price" : "Line total"}
      </Text>
    </View>
  );
  // Flat table when not grouping OR when no line carries a phase (every legacy
  // proposal) — so we never render a lone "General" header + subtotal that just
  // repeats the grand total.
  if (!groupByPhase || !grouping.anyHasPhase) {
    return (
      <View style={styles.liTable}>
        {header}
        {items.map((it) => (
          <LiRow key={it.id} it={it} showAlternateBadge={showAlternateBadge} priceOnly={priceOnly} respectShowPrice={respectShowPrice} />
        ))}
        {scopeTotalLabel && <ScopeTotalRow items={items} label={scopeTotalLabel} respectShowPrice={respectShowPrice} />}
      </View>
    );
  }
  // Grouped by phase. Each phase gets a bold header + its rows + a subtotal
  // row. Subtotals sum the SAME per-line rounded value the grand total uses
  // (lineTotalCents), so Σ(phase subtotals) === grand total to the penny.
  return (
    <View style={styles.liTable}>
      {header}
      {grouping.groups.map((g) => {
        const subtotal = g.rows.reduce((sum, it) => sum + lineTotalCents(it), 0);
        // If ANY row in this phase has its price hidden, don't print a subtotal
        // number. It included the hidden line, so the visible rows didn't add
        // up to it — and the GC could recover the price we deliberately hid by
        // subtracting them. (The flat GRAND total including hidden lines is
        // intentional and documented above; a per-phase subtotal is not the
        // same thing, because it sits directly beneath the rows it contradicts.)
        const hasHiddenPrice = g.rows.some((it) => it.show_price === false);
        const [firstRow, ...restRows] = g.rows;
        return (
          <View key={g.key}>
            {/* Header + first row atomic so a phase header never orphans at a
                page break; remaining rows flow (a 30-row phase can still break). */}
            <View wrap={false}>
              <View style={styles.liPhaseHeader}>
                <Text style={styles.liPhaseHeaderText}>{g.label}</Text>
              </View>
              {firstRow && <LiRow it={firstRow} showAlternateBadge={showAlternateBadge} priceOnly={priceOnly} respectShowPrice={respectShowPrice} />}
            </View>
            {restRows.map((it) => (
              <LiRow key={it.id} it={it} showAlternateBadge={showAlternateBadge} priceOnly={priceOnly} respectShowPrice={respectShowPrice} />
            ))}
            <View style={styles.liSubtotalRow} wrap={false}>
              <Text style={styles.liSubtotalLabel}>{g.label} subtotal</Text>
              <Text style={styles.liSubtotalAmount}>{hasHiddenPrice ? "—" : formatDollars(subtotal)}</Text>
            </View>
          </View>
        );
      })}
      {scopeTotalLabel && <ScopeTotalRow items={items} label={scopeTotalLabel} respectShowPrice={respectShowPrice} />}
    </View>
  );
}

/** Closing total for the base scope table. Skipped when a hidden per-line
 *  price would make the sum unverifiable from the page — a total the reader
 *  cannot check against the lines above it invites exactly the "where does
 *  this number come from" question a proposal exists to prevent. */
function ScopeTotalRow({
  items,
  label,
  respectShowPrice,
}: {
  items: CommercialProposalLineItem[];
  label: string;
  respectShowPrice?: boolean;
}) {
  if (items.length === 0) return null;
  const anyHidden = respectShowPrice === true && items.some((i) => i.show_price === false);
  const sum = items.reduce((n, it) => n + lineTotalCents(it), 0);
  return (
    <View style={styles.liSubtotalRow} wrap={false}>
      <Text style={styles.liSubtotalLabel}>{label}</Text>
      <Text style={styles.liSubtotalAmount}>{anyHidden ? "—" : formatDollars(sum)}</Text>
    </View>
  );
}

// Renders the priced line-item table. Used for the internal Plan Report AND for
// a customer PDF when Alex opts into per-line prices — so the header must NOT
// say "internal" on the customer copy (2026-07-28 re-audit).
function InclusionsInternal({
  items,
  internal,
  groupByPhase = false,
  heading = "Inclusions",
  respectShowPrice = false,
  scopeTotalLabel,
}: {
  items: CommercialProposalLineItem[];
  internal: boolean;
  groupByPhase?: boolean;
  /** Section heading — "Inclusions" for the base scope, "Labor" for the
   *  hourly rows (so the priced view doesn't show two "Inclusions:" headers). */
  heading?: string;
  /** See LiRow — honour the per-line price checkbox on the customer table. */
  respectShowPrice?: boolean;
  /** Closing total under the base scope rows (customer itemized copy). */
  scopeTotalLabel?: string;
}) {
  if (items.length === 0) return null;
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={styles.sectionUnderlineHeader}>{internal ? `${heading} (internal line-item view):` : `${heading}:`}</Text>
      <LineItemTable
        items={items}
        showAlternateBadge={false}
        groupByPhase={groupByPhase}
        priceOnly={!internal}
        respectShowPrice={respectShowPrice}
        scopeTotalLabel={scopeTotalLabel}
      />
    </View>
  );
}

/**
 * Price / NYS Sales Tax / TOTAL — Stephanie's exact three lines.
 *
 * The pre-tax figure is labelled "Price" and not "Subtotal": hers reads
 * Price, and on a one-number bid "subtotal" implies a list of parts above it
 * that a narrative proposal does not have. TOTAL keeps whatever variant the
 * exclusions produced ("Labor Only TOTAL"), because that qualifier still
 * describes what the money covers once tax is added.
 */
function TaxedTotalBlock({ label, tax }: { label: string; tax: ProposalTaxLine }) {
  return (
    <View style={styles.totalRow}>
      <Text style={styles.taxLine}>Price: {formatDollars(tax.priceCents)}</Text>
      <Text style={styles.taxLine}>
        {tax.label}: {formatDollars(tax.taxCents)}
      </Text>
      <Text style={styles.totalText}>
        {label}: {formatDollars(tax.totalCents)}
      </Text>
    </View>
  );
}

function TotalRow({ label, cents }: { label: string; cents: number }) {
  return (
    <View style={styles.totalRow}>
      <Text style={styles.totalText}>
        {label}: {formatDollars(cents)}
      </Text>
    </View>
  );
}

function AlternateSectionCustomer({
  items,
  altNotes,
}: {
  items: CommercialProposalLineItem[];
  altNotes: string | null | undefined;
}) {
  if (items.length === 0 && !altNotes) return null;
  /* Stephanie 2026-08-17: "The alternates are a bit wacky … the bullet is
     coming first with the price and then the verbiage for the alternate and
     then the total price shows up again." — and 2026-08-20: "Might be easier
     to just remove the ADD ALTERNATE total and keep it broken out by item."
     The repeated number WAS the ADD ALTERNATE line restating the sum of the
     items directly above it. Gone; each alternate carries its own price. */
  return (
    <View style={styles.altSection}>
      <Text style={styles.altHeader}>Add Alternate:</Text>
      {altNotes && (
        <Text style={{ marginBottom: 4, fontSize: 11 }}>{altNotes}</Text>
      )}
      {items.map((it) => (
        <ItemLine key={it.id} item={it} />
      ))}
    </View>
  );
}

function AlternateSectionInternal({
  items,
  altNotes,
  internal,
}: {
  items: CommercialProposalLineItem[];
  altNotes: string | null | undefined;
  internal: boolean;
}) {
  if (items.length === 0 && !altNotes) return null;
  return (
    <View style={styles.altSection}>
      <Text style={styles.altHeader}>{internal ? "Alternate (internal):" : "Alternate:"}</Text>
      {altNotes && (
        <Text style={{ marginBottom: 4, fontSize: 11 }}>{altNotes}</Text>
      )}
      {items.length > 0 && <LineItemTable items={items} showAlternateBadge={false} priceOnly={!internal} />}
    </View>
  );
}

/**
 * Qualifications — its own heading, directly after Exclusions.
 *
 * Same bullet grammar as the exclusions above it so the page reads as one
 * document, but a heading of its own: "Assumes one mobilisation" is a condition
 * of the price, not something we are refusing to do, and printing it under
 * "Exclusions:" told a GC the opposite of what was meant.
 */
function QualificationsBlock({ qualifications }: { qualifications: string[] }) {
  if (qualifications.length === 0) return null;
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.sectionUnderlineHeader}>Qualifications:</Text>
      {qualifications.map((q, i) => (
        <View key={i} style={styles.bulletRow}>
          <View style={styles.bulletDot} />
          <Text style={styles.bulletBody}>{q}</Text>
        </View>
      ))}
    </View>
  );
}

function ExclusionsBlock({ exclusions }: { exclusions: string[] }) {
  if (exclusions.length === 0) return null;
  // Karan 2026-07-19 (round 2 1:1): reference header is just
  // "Exclusions:" — no "& Qualifications" suffix.
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.sectionUnderlineHeader}>Exclusions:</Text>
      {exclusions.map((ex, i) => (
        <View key={i} style={styles.bulletRow}>
          <View style={styles.bulletDot} />
          <Text style={styles.bulletBody}>{ex}</Text>
        </View>
      ))}
    </View>
  );
}

/** Migration 063 (2026-07-19, Katie): "Labor:" PDF section for
 *  hourly-billed work. Renders under a bold "Labor:" header with each
 *  labor row as an indented sub-bullet showing "{description} — {hours}
 *  hrs @ {rate}/hr = {subtotal}". Rolls into TOTAL as part of the
 *  standard rollup (same math as inclusions). Suppressed when zero
 *  labor rows so old proposals render unchanged. */
// LaborSection removed 2026-08: labor now renders inside Scope of Work on the
// customer PDF (see InclusionsCustomer's laborItems). The internal PDF still
// prints a separate "Labor" table via InclusionsInternal, where the estimator's
// qty x rate math is the point.

function EstimatorBlock({
  e,
  company,
}: {
  e: ProposalEstimatorSnapshot;
  company?: OperatingCompany | null;
}) {
  // No estimator on the deal and nobody typed one — the block used to disappear
  // entirely, so a proposal went to a GC with no named point of contact at all.
  // Whoever reads it has a question; give them somewhere to send it. The
  // company's own details are the honest fallback: not a person, but reachable.
  if (!e.name && !e.email && !e.phone) {
    if (!company?.phone && !company?.email) return null;
    return (
      <View style={styles.estBlock}>
        <Text style={styles.estHeader}>Questions:</Text>
        <Text style={styles.estName}>{company.name}</Text>
        {company.phone && <Text style={styles.estRow}>{company.phone}</Text>}
        {company.email && <Text style={styles.estRow}>{company.email}</Text>}
      </View>
    );
  }
  return (
    <View style={styles.estBlock}>
      {/* Karan 2026-07-17 (Katie feedback): reference PDF has an
          "Estimator:" bold+underlined header above the block, then
          name/phone/email each on their own line, all bold+underlined. */}
      <Text style={styles.estHeader}>Estimator:</Text>
      {e.name && <Text style={styles.estName}>{e.name}</Text>}
      {e.title && <Text style={styles.estRow}>{e.title}</Text>}
      {/* Brendan 2026-08-17: "Phone number, title and email are not showing on
          pdf for client." The block rendered whatever the snapshot held — and
          the snapshot only ever pre-filled name and email, so a proposal went
          out naming the estimator with no way to reach them.

          Phone and title now pre-fill from the profile (hydrate), and these
          fall back to the company's own contact details so this block can
          NEVER be a dead end: the GC always has a number and an address to
          reply to, even on a proposal created before any of that was set. */}
      {(e.phone || company?.phone) && (
        <Text style={styles.estRow}>{e.phone || company?.phone}</Text>
      )}
      {(e.email || company?.email) && (
        <Text style={styles.estRow}>{e.email || company?.email}</Text>
      )}
    </View>
  );
}

/**
 * Sign-and-return block, with the estimator's details inside it.
 *
 * Stephanie 2026-08-17 ("Can we make the sign off prettier? See below") and
 * again 2026-08-20 ("The estimator sign off still kind of lame looking. Please
 * update to the one I provided"). Her layout, verbatim:
 *
 *     PLEASE SIGN AND RETURN APPROVED COPY OF PROPOSAL
 *     Authorized Client Signature: ______________________ Date: ___________
 *     Brendan Dwyer
 *     Lead Estimator, Tomco Painting
 *     631-300-8984
 *     Brendan@Tomcopainting.com
 *
 * The name sits UNDER the signature line as the person returning it to, and
 * the title carries the company on the same line — so this is not the old
 * "Estimator:" block moved down, it is a different shape. The separate
 * EstimatorBlock is therefore skipped whenever this renders, or the reader
 * gets the same four facts twice on one page.
 */
function SignatureBlock({
  e,
  company,
}: {
  e: ProposalEstimatorSnapshot;
  company?: OperatingCompany | null;
}) {
  const name = e.name?.trim();
  // "Lead Estimator, Tomco Painting" — title and company on one line, which is
  // how she wrote it. Either half alone still reads correctly.
  const titleLine = [e.title?.trim(), company?.name?.trim()].filter(Boolean).join(", ");
  const phone = e.phone?.trim() || company?.phone?.trim();
  const email = e.email?.trim() || company?.email?.trim();
  return (
    <View style={styles.signBlock}>
      <Text style={styles.signHeading}>
        PLEASE SIGN AND RETURN APPROVED COPY OF PROPOSAL
      </Text>
      <Text style={styles.signLine}>
        Authorized Client Signature: _____________________________________ Date: _______________
      </Text>
      {(name || titleLine || phone || email) && (
        <View style={styles.signContact}>
          {name && <Text style={styles.signContactName}>{name}</Text>}
          {titleLine && <Text style={styles.signContactRow}>{titleLine}</Text>}
          {phone && <Text style={styles.signContactRow}>{phone}</Text>}
          {email && <Text style={styles.signContactRow}>{email}</Text>}
        </View>
      )}
    </View>
  );
}

// ─── Main document ──────────────────────────────────────────────────

export type ProposalPdfMode = "customer" | "internal";

export type RenderProposalArgs = {
  proposal: CommercialProposal;
  lineItems: CommercialProposalLineItem[];
  exclusions: string[]; // resolved text list (already ordered per Alex)
  /**
   * Conditions the price depends on, printed as their own section AFTER
   * Exclusions (Stephanie 2026-08-17: "Qualifications should be its own section
   * after exclusions, not grouped in with alternates").
   *
   * Separate from `exclusions` rather than folded in, because the two say
   * different things — one is work we are not doing, the other is what the
   * price assumes — and because proposalTotalLabel reads the exclusions list to
   * decide "Labor Only TOTAL". A qualification must not be able to relabel the
   * total.
   */
  qualifications?: string[];
  mode?: ProposalPdfMode;
  showSignatureBlock?: boolean;
  /**
   * The operating company, for the letterhead footer.
   *
   * The footer was a hard-coded string. Work orders and closeout documents both
   * read these fields, so changing the company phone or address in Settings
   * updated those and left PROPOSALS going out with the old details — on the one
   * document a customer replies to. Optional so an un-updated caller still
   * renders; it falls back to the same literal that used to be there.
   */
  company?: OperatingCompany | null;
  /**
   * Sales tax for this job, or null when no line should print.
   *
   * Stephanie 2026-08-20: "Sales Tax isn't carrying over to proposal." It had
   * no tax concept at all — tax first appeared at INVOICE, so a GC signed one
   * number and was billed a bigger one. Computed by proposal-tax.ts from the
   * same ZIP + jurisdictions the invoice uses, so the two cannot disagree.
   */
  tax?: ProposalTaxLine | null;
};

export function ProposalPdfDocument({
  proposal,
  lineItems,
  exclusions,
  mode = "customer",
  // Karan 2026-07-19 (round 2 1:1): reference PDF does NOT include a
  // "PLEASE SIGN AND RETURN APPROVED COPY OF PROPOSAL" line — the
  // rendered reference ends with Estimator sign-off + footer. Prior
  // "always sign" default was based on Katie feedback that turned out
  // not to match Alex's actual customer-facing letterhead. Default
  // OFF; callers can flip it on explicitly if a specific proposal
  // needs the sign line.
  showSignatureBlock = false,
  company = null,
  tax = null,
  qualifications = [],
}: RenderProposalArgs) {
  // Migration 063 (2026-07-19): labor rows render in their own PDF
  // section between Inclusions and Alternates. Rolls into TOTAL like
  // inclusions (which is why we filter them out of the inclusions
  // bucket here — they'd double-count the TOTAL otherwise).
  const inclusions = lineItems.filter((i) => !i.is_alternate && !i.is_labor);
  const laborRows = lineItems.filter((i) => !i.is_alternate && i.is_labor);
  const alternates = lineItems.filter((i) => i.is_alternate);
  const totalLabel = proposalTotalLabel(exclusions);
  // Karan 2026-08: "The bid set should carry over to the proposal in the intro
  // paragraph." The Bid Set date already printed as its own line above the
  // intro, which read as a stray field; folding it into the sentence is how
  // Tomco's proposals actually word it — the client sees WHICH set was priced
  // in the same breath as what's being proposed. Only appended to the DEFAULT
  // intro: an estimator who wrote their own paragraph owns it, and silently
  // editing their words would be worse than a missing date.
  const baseIntro = proposal.intro_text_override?.trim();
  // Stephanie 2026-08-13 wants the bid set inside the opening sentence
  // ("...the following proposal based on plans dated ..."), not trailing after
  // the paragraph as a footnote. Only applied to the DEFAULT intro: an
  // estimator who wrote their own paragraph owns it, and silently rewording
  // their sentence would be worse than a missing date.
  const intro =
    baseIntro ||
    tomcoDefaultIntro(proposal.bid_set_date ? formatDateLong(proposal.bid_set_date) : null);
  const dateLabel = formatDateLong(proposal.header_json.date_iso);
  // Round-3 audit fix: pdf_show_line_prices was a dead toggle — the
  // editor checkbox existed but the renderer ignored it. Now: internal
  // mode always shows the line-item table (estimator math); customer
  // mode shows the line-item table when Alex opts in via the toggle
  // ("Show per-line prices on customer PDF"), otherwise stays on the
  // Tomco-default narrative-bullets rendering.
  // When a final-price OVERRIDE is set, proposal.total_cents (the printed TOTAL)
  // no longer equals the sum of the itemized line prices. Showing per-line
  // prices / phase subtotals / a labor subtotal on the CUSTOMER copy would then
  // visibly contradict the TOTAL (#4). Internal mode always keeps the real
  // itemized math (the estimator set the override); the customer copy drops all
  // itemized prices so only the single, reconciled TOTAL shows.
  const itemizedSumCents = [...inclusions, ...laborRows].reduce((s, it) => s + lineTotalCents(it), 0);
  const overrideActive = mode !== "internal" && Math.abs(proposal.total_cents - itemizedSumCents) > 1;
  // On the INTERNAL report the itemized math is deliberately kept, so an
  // override means the printed line prices genuinely do not add up to the
  // TOTAL beneath them. That is correct — but silently correct, and the person
  // reading it is the approver checking exactly that arithmetic. Say so.
  const overrideOnInternal =
    mode === "internal" && Math.abs(proposal.total_cents - itemizedSumCents) > 1;
  const showLineTable = mode === "internal" || (proposal.pdf_show_line_prices && !overrideActive);
  // The per-line "show price" checkbox is only meaningful once somebody has
  // ticked at least one line. Until then every line reads false — that is the
  // migration-148 backfill, not a decision — and honouring it would blank the
  // whole itemized table. See LiRow.
  const respectShowPrice = lineItems.some((i) => i.show_price === true);

  return (
    <Document
      title={`Tomco Proposal R${proposal.revision_number}`}
      author="Tomco Painting"
      subject={proposal.header_json.project_name ?? "Proposal"}
    >
      <Page size="LETTER" style={styles.page}>
        {/* Karan 2026-07-21: subtle NEUTRAL paper texture behind all
            content (first child = furthest back). Gray speckle only —
            never the warm cream that read as "too yellow" before. */}
        <PaperTexture />
        {/* Single red keyline border wraps every page. */}
        <View style={styles.borderFrame} fixed />

        <LogoBlock
          dateLabel={dateLabel}
          dealNumber={
            proposal.header_json.proposal_number?.trim() || `R${proposal.revision_number}`
          }
        />
        <SubmittedToBlock h={proposal.header_json} />
        <ProjectBlock h={proposal.header_json} revisionLabel={proposalRevisionLabel(proposal)} />
        {/* Bid Set date. Folded into the intro sentence when we're using the
            default intro (see above); still printed as its own line when the
            estimator supplied a custom intro, so the date is never lost. */}
        {/* On the INTERNAL report the date always prints as its own line,
            because the intro paragraph it would otherwise live inside is not
            rendered there (see below) — and which set was priced is exactly
            what an internal reviewer is checking. */}
        {proposal.bid_set_date && (baseIntro || mode === "internal") && (
          <Text style={{ fontSize: 10, color: CHARCOAL, marginTop: 4 }}>
            <Text style={{ fontFamily: "Times-Bold" }}>Bid Set Date: </Text>
            {formatDateLong(proposal.bid_set_date)}
          </Text>
        )}
        {/* Stephanie 2026-08-13: "Don't need the intro paragraph on report,
            this is for internal review only." The sales paragraph is addressed
            to the GC; on an estimator's review copy it is a screenful of
            boilerplate between them and the numbers they opened it for. */}
        {mode !== "internal" && <Text style={styles.intro}>{intro}</Text>}

        {showLineTable ? (
          <>
            {overrideOnInternal && (
              <Text
                style={{
                  fontSize: 9,
                  color: "#92400e",
                  backgroundColor: YELLOW_BG,
                  borderWidth: 1,
                  borderColor: YELLOW_BORDER,
                  padding: 6,
                  marginBottom: 6,
                }}
              >
                <Text style={{ fontFamily: "Times-Bold" }}>Final price override in effect. </Text>
                The line prices below sum to {formatDollars(itemizedSumCents)}; the TOTAL is set
                manually to {formatDollars(proposal.total_cents)}. The customer copy shows only
                the TOTAL.
              </Text>
            )}
            <InclusionsInternal
              items={inclusions}
              internal={mode === "internal"}
              groupByPhase
              respectShowPrice={respectShowPrice}
              scopeTotalLabel={mode === "internal" ? undefined : "Total scope"}
            />
          </>
        ) : (
          <InclusionsCustomer
            items={inclusions}
            laborItems={laborRows}
            hideLaborPrices={overrideActive}
          />
        )}

        {/* Migration 063 (2026-07-19, Katie): Labor:
            hourly-billed rows render as their own bullet section between
            Inclusions and Alternates. Included in TOTAL. Internal-mode
            renders labor rows inline in the standard line-item table
            (they carry price + qty just like inclusions). */}
        {/* Labor no longer prints as its own customer-facing section — it's
            inside Scope of Work above (Karan 2026-08). Internal mode keeps the
            separate "Labor" table below, where the estimator's qty/rate math
            is the whole point. */}
        {showLineTable && laborRows.length > 0 && (
          <InclusionsInternal
            items={laborRows}
            internal={mode === "internal"}
            heading="Labor"
            respectShowPrice={respectShowPrice}
          />
        )}

        {/* ORDER — Stephanie 2026-08-17 and again 2026-08-20, both rounds:
            "Total price goes after scope/inclusions · Alternate goes after
            total price · Then Exclusions" and "Total price goes before
            exclusions, not after".

            This REVERSES Karan's 2026-07-19 "1:1 reference match" call, which
            put Exclusions before the TOTAL to mirror the reference PDF we had
            captured. Stephanie sends these proposals out of Tomco daily and
            has asked twice, so her ordering wins over our reading of one
            sample. Flagged to Karan rather than changed quietly.

            Flow is now: Scope of Work → TOTAL → Alternate → Exclusions →
            Qualifications → sign-off. */}
        {tax ? (
          <TaxedTotalBlock label={totalLabel} tax={tax} />
        ) : (
          <TotalRow label={totalLabel} cents={proposal.total_cents} />
        )}

        {/* Katie 2026-08-13: "on the proposal PDF the Alternates should be
            below the final price so that it doesn't look like those items are
            included in the full price."

            They never were — `total_cents` sums only `is_alternate = false`
            (the rollup rule in proposals/db). But printing them ABOVE the
            total made them read as part of it, and a GC reading a bid does not
            check our rollup rule. Below the total they read as what they are:
            priced options the customer can add. */}
        {showLineTable ? (
          <AlternateSectionInternal
            items={alternates}
            altNotes={proposal.alternate_notes}
            internal={mode === "internal"}
          />
        ) : (
          <AlternateSectionCustomer
            items={alternates}
            altNotes={proposal.alternate_notes}
          />
        )}

        <ExclusionsBlock exclusions={exclusions} />

        <QualificationsBlock qualifications={qualifications} />


        {/* CIP notice: inline yellow-highlighted bold line above the
            sign-and-return heading — matches Tomco reference PDF exactly
            (NOT a full-width left-border banner). Suppressed on
            internal-mode PDFs so the estimator-math view can't be
            mistaken for a customer copy. */}
        {mode === "customer" && proposal.header_json.show_capital_improvement_notice && (
          <View style={styles.ciWrap}>
            <Text style={styles.ciText}>
              Subject to Certificate of Capital Improvement or New York State Sales Tax.
            </Text>
          </View>
        )}
        {/* Internal-mode watermark + bid notes so a screenshot-shared
            internal PDF can't be mistaken for what went to the GC, and
            the estimator scratch-pad from the editor actually surfaces
            on the review PDF (Karan 2026-07-15). */}
        {mode === "internal" && (
          <>
            <View style={{ marginTop: 14, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: "#FEF3C7", borderLeftWidth: 3, borderLeftColor: "#F59E0B" }}>
              <Text style={{ fontSize: 9, fontFamily: "Times-Bold", color: "#92400E", textTransform: "uppercase", letterSpacing: 1 }}>
                Internal · estimator view · not for customer
              </Text>
            </View>
            {proposal.bid_notes && proposal.bid_notes.trim() && (
              <View style={{ marginTop: 10, padding: 8, backgroundColor: "#F3F4F6", borderLeftWidth: 3, borderLeftColor: MUTED }}>
                <Text style={{ fontSize: 9, fontFamily: "Times-Bold", color: MUTED, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>
                  Bid notes (internal)
                </Text>
                <Text style={{ fontSize: 10, color: CHARCOAL, lineHeight: 1.4 }}>
                  {proposal.bid_notes.trim()}
                </Text>
              </View>
            )}
          </>
        )}

        {/* Karan 2026-07-19 (1:1 reference match): Estimator block sits
            RIGHT after the TOTAL / CI notice — bottom-left of the page
            in the reference. Sign-and-return line comes last, well
            below the estimator, so it doesn't split the natural
            "here's the number, here's who to reach" flow. */}
        {/* One or the other, never both — the sign-off now carries the same
            name/title/phone/email, and printing the old "Estimator:" block
            above it repeated all four on the same page. Internal/review
            copies have no sign-off, so they keep the standalone block. */}
        {showSignatureBlock ? (
          <SignatureBlock e={proposal.estimator_snapshot_json} company={company} />
        ) : (
          <EstimatorBlock e={proposal.estimator_snapshot_json} company={company} />
        )}

        {/* Footer fixed to bottom of every page. Karan 2026-07-17
            (Katie feedback: "Footer is getting cut off"): moved 30pt
            higher inside the red keyline border with real breathing
            room. Single centered line with short red rule flanks +
            RED bold labels for Tel/Fax/Web — matches the reference
            PDF letterhead. */}
        <View style={styles.footerRow} fixed>
          <View style={styles.footerRuleFlank} />
          <Text style={styles.footerText}>
            {[company?.address_line1, company?.address_line2].filter(Boolean).join(", ") ||
              "77-13 Windsor Place"}{" "}
            •{" "}
            {[company?.city, company?.state].filter(Boolean).join(", ")}
            {company?.zip ? ` ${company.zip}` : ""}
            {!company?.city && !company?.zip ? "Central Islip, NY 11722" : ""} •{" "}
            <Text style={styles.footerLabel}>Tel:</Text> {company?.phone || "631.582.2770"}
            {company?.fax || !company ? (
              <>
                {" "}
                • <Text style={styles.footerLabel}>Fax:</Text> {company?.fax || "631.582.2771"}
              </>
            ) : null}{" "}
            • <Text style={styles.footerLabel}>Web:</Text>{" "}
            {company?.website || "www.tomcopainting.com"}
          </Text>
          <View style={styles.footerRuleFlank} />
        </View>
        <Text
          style={styles.pageNumber}
          fixed
          render={({ pageNumber, totalPages }) =>
            totalPages > 1 ? `${pageNumber} / ${totalPages}` : ""
          }
        />
      </Page>
    </Document>
  );
}

/** Render the proposal PDF to a Buffer. Called from the API route handler
 *  via dynamic import so react-pdf stays out of every other bundle. */
export async function renderProposalPdf(args: RenderProposalArgs): Promise<Buffer> {
  return renderToBuffer(<ProposalPdfDocument {...args} />);
}
