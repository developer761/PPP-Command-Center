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

import {
  TOMCO_COMPANY_FOOTER,
  TOMCO_DEFAULT_INTRO,
  proposalTotalLabel,
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
  return s.replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").trim();
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
  const hasAttentionBlock = Boolean(h.attention || h.phone || h.email);
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
            <Text style={styles.addrLine}>Attn: {h.attention}</Text>
          )}
          {h.phone && <Text style={styles.addrLine}>P: {h.phone}</Text>}
          {h.email && (
            <Text style={[styles.addrLine, styles.link]}>{h.email}</Text>
          )}
        </View>
      )}
    </View>
  );
}

function ProjectBlock({ h }: { h: ProposalHeaderJson }) {
  const name = h.project_name?.trim();
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
  if (productName) {
    const raw = normalizeWs(item.description ?? "");
    const bodyLines = raw.includes("\n")
      ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : raw
      ? [raw]
      : [];
    return (
      <View style={styles.itemLine}>
        <Text style={{ fontSize: 11 }}>
          <Text style={styles.bulletLead}>{productName}</Text>
          {/* Single-line description sits inline after an em-dash; a
              multi-line description drops to indented sub-bullets below. */}
          {bodyLines.length === 1 ? <Text>{" — " + bodyLines[0]}</Text> : null}
        </Text>
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
  return <BulletLine text={item.description} />;
}

function BulletLine({ text }: { text: string }) {
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
        <Text style={{ fontSize: 11 }}>
          <Text style={styles.bulletLead}>{lead}:</Text>
          {bodyLines[0] ? <Text>{" " + bodyLines[0]}</Text> : null}
        </Text>
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
          <Text key={i} style={{ fontSize: 11 }}>{line}</Text>
        ))}
      </View>
    );
  }
  return <Text style={styles.itemLine}>{body}</Text>;
}

function InclusionsCustomer({ items }: { items: CommercialProposalLineItem[] }) {
  if (items.length === 0) return null;
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
  const anyHasPhase = items.some((it) => it.phase && it.phase.trim());
  if (!anyHasPhase) {
    return (
      <View style={{ marginTop: 14 }}>
        <Text style={styles.sectionUnderlineHeader}>Scope of Work:</Text>
        <View style={{ marginTop: 4 }}>
          {items.map((it) => (
            <ItemLine key={it.id} item={it} />
          ))}
        </View>
      </View>
    );
  }
  // Group + preserve insertion order per phase. Ungrouped items surface
  // first as "General scope".
  type Group = { key: string; label: string; rows: CommercialProposalLineItem[] };
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  const ungroupedKey = "__ungrouped__";
  for (const it of items) {
    const raw = it.phase?.trim();
    // 2026-07-21 audit (footgun): group on a NORMALIZED key (lowercased +
    // internal-whitespace-collapsed) so "Phase 1" / "phase 1" / "Phase  1"
    // merge into ONE section instead of rendering as two — a
    // customer-visible broken proposal that a mobile field user could
    // easily trip. The DISPLAY label stays the FIRST-seen spelling (byKey
    // dedup keeps g.label from group creation).
    const key = raw ? raw.toLowerCase().replace(/\s+/g, " ") : ungroupedKey;
    // F.6 audit fix: bucket label "General Scope" would collide with a
    // literal user-typed phase named "General Scope". Use a sentinel
    // label ("General") that's short + unlikely to be typed as a phase
    // name (Alex uses "Phase 1", "Base Contract", etc.).
    const label = raw || "General";
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(it);
  }
  // Move ungrouped to the front so unphased items always render first.
  groups.sort((a, b) => {
    if (a.key === ungroupedKey) return -1;
    if (b.key === ungroupedKey) return 1;
    return 0;
  });
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
    </View>
  );
}

function LineItemTable({
  items,
  showAlternateBadge,
}: {
  items: CommercialProposalLineItem[];
  showAlternateBadge: boolean;
}) {
  return (
    <View style={styles.liTable}>
      <View style={styles.liHeaderRow}>
        <Text style={[styles.liHeaderCell, styles.liCellDesc]}>Description</Text>
        <Text style={[styles.liHeaderCell, styles.liCellQty]}>Qty</Text>
        <Text style={[styles.liHeaderCell, styles.liCellUnit]}>Unit</Text>
        <Text style={[styles.liHeaderCell, styles.liCellPrice]}>Unit price</Text>
        <Text style={[styles.liHeaderCell, styles.liCellLine]}>Line total</Text>
      </View>
      {items.map((it) => {
        const line = Math.round(Number(it.quantity) * it.unit_price_cents);
        return (
          <View key={it.id} style={styles.liRow}>
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
            <Text style={[styles.liCell, styles.liCellQty]}>{it.quantity}</Text>
            <Text style={[styles.liCell, styles.liCellUnit]}>{productUnitLabel(it.unit)}</Text>
            <Text style={[styles.liCell, styles.liCellPrice]}>
              {formatDollars(it.unit_price_cents)}
            </Text>
            <Text style={[styles.liCell, styles.liCellLine]}>
              {formatDollars(line)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function InclusionsInternal({ items }: { items: CommercialProposalLineItem[] }) {
  if (items.length === 0) return null;
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={styles.sectionUnderlineHeader}>Inclusions (internal line-item view):</Text>
      <LineItemTable items={items} showAlternateBadge={false} />
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
  const total = items.reduce(
    (sum, it) => sum + Math.round(Number(it.quantity) * it.unit_price_cents),
    0
  );
  return (
    <View style={styles.altSection}>
      <Text style={styles.altHeader}>Alternate:</Text>
      {altNotes && (
        <Text style={{ marginBottom: 4, fontSize: 11 }}>{altNotes}</Text>
      )}
      {items.map((it) => (
        <ItemLine key={it.id} item={it} />
      ))}
      {items.length > 0 && (
        <Text style={styles.altAmount}>ADD ALTERNATE: {formatDollars(total)}</Text>
      )}
    </View>
  );
}

function AlternateSectionInternal({
  items,
  altNotes,
}: {
  items: CommercialProposalLineItem[];
  altNotes: string | null | undefined;
}) {
  if (items.length === 0 && !altNotes) return null;
  return (
    <View style={styles.altSection}>
      <Text style={styles.altHeader}>Alternate (internal):</Text>
      {altNotes && (
        <Text style={{ marginBottom: 4, fontSize: 11 }}>{altNotes}</Text>
      )}
      {items.length > 0 && <LineItemTable items={items} showAlternateBadge={false} />}
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
function LaborSection({ items }: { items: CommercialProposalLineItem[] }) {
  if (items.length === 0) return null;
  const totalCents = items.reduce(
    (acc, it) => acc + Math.round(Number(it.quantity) * it.unit_price_cents),
    0
  );
  const totalHours = items.reduce((acc, it) => acc + Number(it.quantity), 0);
  const renderRow = (it: CommercialProposalLineItem) => {
    const subtotal = Math.round(Number(it.quantity) * it.unit_price_cents);
    const hrs = Number(it.quantity);
    const rate = it.unit_price_cents / 100;
    return (
      <View key={it.id} style={styles.bulletSubRow}>
        <View style={styles.bulletSubDot} />
        <Text style={styles.bulletSubBody}>
          {it.description} — {hrs} {hrs === 1 ? "hr" : "hrs"} @ ${rate.toFixed(2)}/hr = ${(subtotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      </View>
    );
  };
  // 2026-07-21 audit: only keep the header + first row atomic; remaining
  // rows flow across pages. wrap={false} on the WHOLE section (the old
  // code) would overflow/clip a labor-heavy proposal — the same bug that
  // was already fixed for phase groups.
  return (
    <View style={{ marginTop: 14 }}>
      <View wrap={false}>
        <Text style={styles.sectionUnderlineHeader}>Labor:</Text>
        <View style={{ marginTop: 4 }}>{renderRow(items[0]!)}</View>
      </View>
      {items.length > 1 && <View>{items.slice(1).map(renderRow)}</View>}
      <Text style={{ fontSize: 10, color: MUTED, marginTop: 3, marginLeft: 12 }}>
        Labor subtotal: {totalHours} {totalHours === 1 ? "hr" : "hrs"} — ${(totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </Text>
    </View>
  );
}

function EstimatorBlock({ e }: { e: ProposalEstimatorSnapshot }) {
  if (!e.name && !e.email && !e.phone) return null;
  return (
    <View style={styles.estBlock}>
      {/* Karan 2026-07-17 (Katie feedback): reference PDF has an
          "Estimator:" bold+underlined header above the block, then
          name/phone/email each on their own line, all bold+underlined. */}
      <Text style={styles.estHeader}>Estimator:</Text>
      {e.name && <Text style={styles.estName}>{e.name}</Text>}
      {e.title && <Text style={styles.estRow}>{e.title}</Text>}
      {e.phone && <Text style={styles.estRow}>{e.phone}</Text>}
      {e.email && <Text style={styles.estRow}>{e.email}</Text>}
    </View>
  );
}

function SignatureBlock() {
  return (
    <View style={styles.signBlock}>
      <Text style={styles.signHeading}>
        PLEASE SIGN AND RETURN APPROVED COPY OF PROPOSAL
      </Text>
      <Text style={styles.signLine}>
        Authorized Client Signature: _____________________________________ Date: _______________
      </Text>
    </View>
  );
}

// ─── Main document ──────────────────────────────────────────────────

export type ProposalPdfMode = "customer" | "internal";

export type RenderProposalArgs = {
  proposal: CommercialProposal;
  lineItems: CommercialProposalLineItem[];
  exclusions: string[]; // resolved text list (already ordered per Alex)
  mode?: ProposalPdfMode;
  showSignatureBlock?: boolean;
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
}: RenderProposalArgs) {
  // Migration 063 (2026-07-19): labor rows render in their own PDF
  // section between Inclusions and Alternates. Rolls into TOTAL like
  // inclusions (which is why we filter them out of the inclusions
  // bucket here — they'd double-count the TOTAL otherwise).
  const inclusions = lineItems.filter((i) => !i.is_alternate && !i.is_labor);
  const laborRows = lineItems.filter((i) => !i.is_alternate && i.is_labor);
  const alternates = lineItems.filter((i) => i.is_alternate);
  const totalLabel = proposalTotalLabel(exclusions);
  const intro = proposal.intro_text_override?.trim() || TOMCO_DEFAULT_INTRO;
  const dateLabel = formatDateLong(proposal.header_json.date_iso);
  // Round-3 audit fix: pdf_show_line_prices was a dead toggle — the
  // editor checkbox existed but the renderer ignored it. Now: internal
  // mode always shows the line-item table (estimator math); customer
  // mode shows the line-item table when Alex opts in via the toggle
  // ("Show per-line prices on customer PDF"), otherwise stays on the
  // Tomco-default narrative-bullets rendering.
  const showLineTable = mode === "internal" || proposal.pdf_show_line_prices;

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
          dealNumber={proposal.header_json.proposal_number?.trim() || null}
        />
        <SubmittedToBlock h={proposal.header_json} />
        <ProjectBlock h={proposal.header_json} />
        <Text style={styles.intro}>{intro}</Text>

        {showLineTable ? (
          <InclusionsInternal items={inclusions} />
        ) : (
          <InclusionsCustomer items={inclusions} />
        )}

        {/* Migration 063 (2026-07-19, Katie): Labor:
            hourly-billed rows render as their own bullet section between
            Inclusions and Alternates. Included in TOTAL. Internal-mode
            renders labor rows inline in the standard line-item table
            (they carry price + qty just like inclusions). */}
        {!showLineTable && <LaborSection items={laborRows} />}
        {showLineTable && laborRows.length > 0 && (
          <InclusionsInternal items={laborRows} />
        )}

        {showLineTable ? (
          <AlternateSectionInternal
            items={alternates}
            altNotes={proposal.alternate_notes}
          />
        ) : (
          <AlternateSectionCustomer
            items={alternates}
            altNotes={proposal.alternate_notes}
          />
        )}

        {/* Karan 2026-07-19 (1:1 reference match): Exclusions come
            BEFORE the TOTAL row, not after. Reference flow is
            intro → scope items → exclusions → TOTAL → estimator. */}
        <ExclusionsBlock exclusions={exclusions} />

        <TotalRow label={totalLabel} cents={proposal.total_cents} />

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
        <EstimatorBlock e={proposal.estimator_snapshot_json} />

        {showSignatureBlock && <SignatureBlock />}

        {/* Footer fixed to bottom of every page. Karan 2026-07-17
            (Katie feedback: "Footer is getting cut off"): moved 30pt
            higher inside the red keyline border with real breathing
            room. Single centered line with short red rule flanks +
            RED bold labels for Tel/Fax/Web — matches the reference
            PDF letterhead. */}
        <View style={styles.footerRow} fixed>
          <View style={styles.footerRuleFlank} />
          <Text style={styles.footerText}>
            77-13 Windsor Place • Central Islip, NY 11722 •{" "}
            <Text style={styles.footerLabel}>Tel:</Text> 631.582.2770 •{" "}
            <Text style={styles.footerLabel}>Fax:</Text> 631.582.2771 •{" "}
            <Text style={styles.footerLabel}>Web:</Text> www.tomcopainting.com
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
