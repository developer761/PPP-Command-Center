import "server-only";

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
  Font,
} from "@react-pdf/renderer";
import * as React from "react";

import {
  TOMCO_COMPANY_FOOTER,
  TOMCO_DEFAULT_INTRO,
  proposalTotalLabel,
} from "./constants";
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

const RED = "#B91C1C"; // Tomco brand red — matches cc-brand-700
const CHARCOAL = "#1F2937";
const MUTED = "#4B5563";
const YELLOW_BG = "#FEF3C7";
const YELLOW_BORDER = "#F59E0B";
const LINK_BLUE = "#1D4ED8";

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingHorizontal: 48,
    // Karan 2026-07-15: bumped from 68 → 96 so the fixed footer
    // (Windsor Place address + tel/fax/web line) doesn't overlap
    // page content on multi-page proposals AND doesn't get clipped
    // by the red keyline border.
    paddingBottom: 96,
    fontSize: 11,
    fontFamily: "Times-Roman",
    color: CHARCOAL,
    lineHeight: 1.35,
  },
  // Red keyline border wraps the whole page (fixed absolute) — Tomco's
  // signature look. Bumped bottom edge from 48 → 78 so the footer
  // (which sits at bottom 32) has room INSIDE the border.
  borderFrame: {
    position: "absolute",
    top: 24,
    left: 28,
    right: 28,
    bottom: 78,
    borderStyle: "solid",
    borderWidth: 1.5,
    borderColor: RED,
  },
  borderInner: {
    position: "absolute",
    top: 28,
    left: 32,
    right: 32,
    bottom: 82,
    borderStyle: "solid",
    borderWidth: 0.5,
    borderColor: RED,
  },
  // Header row: TOMCO wordmark centered inside a red-dashed rule that
  // spans the page width, date pinned top-right (also floats above).
  // The reference PDF's logo is a graphic wordmark with dashed rules
  // to its left and right — we recreate the dashes with two flex-1
  // borderTop lines that visually anchor the wordmark.
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    marginTop: 2,
    minHeight: 44,
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
    position: "absolute",
    top: 46,
    right: 48,
    fontSize: 12,
    color: CHARCOAL,
    fontFamily: "Times-Bold",
  },
  dateText: {
    fontSize: 12,
    color: CHARCOAL,
    fontFamily: "Times-Bold",
    minWidth: 90,
    textAlign: "right",
  },
  sectionUnderlineHeader: {
    fontSize: 11,
    fontFamily: "Times-Bold",
    textDecoration: "underline",
    marginTop: 12,
    marginBottom: 4,
  },
  addrBlock: {
    marginLeft: 18,
    marginTop: 4,
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
    marginTop: 14,
    marginBottom: 14,
    fontSize: 11,
    // Karan 2026-07-15: dropped Times-Bold → Times-Roman for the intro.
    // The old rendering read as "way too bold" (near-black at the
    // top of every proposal). Reference PDF uses a lighter weight
    // here; regular Times matches the customer-facing polish.
    fontFamily: "Times-Roman",
    lineHeight: 1.4,
  },
  bulletRow: {
    flexDirection: "row",
    marginBottom: 3,
    paddingRight: 4,
    alignItems: "flex-start",
  },
  // Karan 2026-07-15: switched from `●` character (which rendered as
  // "Ï" — the missing-glyph fallback — because the react-pdf built-in
  // Times-Roman font doesn't include U+25CF in its char map) to a real
  // filled dot drawn as a small circular View. Works with any font.
  bulletDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: CHARCOAL,
    marginTop: 6,
    marginLeft: 4,
    marginRight: 8,
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
    marginBottom: 6,
    fontSize: 11,
  },
  totalRow: {
    marginTop: 18,
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
  estName: {
    fontFamily: "Times-Bold",
    fontSize: 12,
    marginBottom: 2,
  },
  estRow: {
    color: CHARCOAL,
    fontFamily: "Times-Bold",
    fontSize: 11,
  },
  // Karan 2026-07-15: pushed the footer INSIDE the red keyline border
  // and gave it a red top-rule for visual anchoring (matches the
  // reference PDF's dashed rule + centered address block). Bottom
  // pinned at 46 so both the address line and tel/fax/web line sit
  // above the border edge (78) with breathing room.
  footerRule: {
    position: "absolute",
    left: 40,
    right: 40,
    bottom: 66,
    borderTopWidth: 0.75,
    borderTopColor: RED,
    borderStyle: "solid",
  },
  footer: {
    position: "absolute",
    left: 48,
    right: 48,
    bottom: 42,
    fontSize: 8,
    color: MUTED,
    textAlign: "center",
  },
  pageNumber: {
    position: "absolute",
    right: 48,
    bottom: 30,
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

/** Split "**Bold lead:** rest of the sentence." into the two parts so we
 *  can render the lead in Times-Bold and the rest in Times-Roman.
 *  Tomco's convention is a single colon-terminated bold lead, e.g.
 *  "GWB Ceiling & Soffit:" or "Doors and Frames:". Reject sentence-medial
 *  colons — "This is a very long clause: continues past" should NOT split. */
function splitBoldLead(text: string): { lead: string | null; body: string } {
  const trimmed = text.trim();
  // Explicit **bold** wrapper first (markdown-style) — always trust it.
  const md = /^\*\*(.+?)\*\*[:：]?\s*(.*)$/.exec(trimmed);
  if (md) {
    return { lead: md[1].trim(), body: md[2].trim() };
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

function LogoBlock({ dateLabel }: { dateLabel: string }) {
  return (
    <>
      <View style={styles.headerRow}>
        <View style={styles.logoDashLeft} />
        <View style={styles.logoBlock}>
          <Text style={styles.logoText}>TOMCO</Text>
          <Text style={styles.logoSub}>PAINTING</Text>
        </View>
        <View style={styles.logoDashRight} />
      </View>
      {dateLabel && <Text style={styles.dateFloat}>{dateLabel}</Text>}
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
      {/* Blank-line separator + Attention block, also indented + bold. */}
      {hasAttentionBlock && (
        <View style={[styles.addrBlock, { marginTop: 10 }]}>
          {h.attention && (
            <Text style={styles.addrLine}>Attention:  {h.attention}</Text>
          )}
          {h.phone && <Text style={styles.addrLine}>P: {h.phone}</Text>}
          {h.email && (
            <Text style={styles.addrLine}>{h.email}</Text>
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
          {bodyLines[0] ? ` ${bodyLines[0]}` : ""}
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
  // No bold lead → bullet the line the same way exclusions are
  // bulleted. Karan 2026-07-15: "Gas Pipes" / "Base Molding - Prep &
  // Paint 2 Coats" / any item without a colon-bold lead should read
  // as a bulleted point, matching the Exclusions & Qualifications
  // section's visual grammar.
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletBody}>{body}</Text>
    </View>
  );
}

function InclusionsCustomer({ items }: { items: CommercialProposalLineItem[] }) {
  if (items.length === 0) return null;
  // Reference PDF has NO "Inclusions:" header — line items just come
  // right after the intro paragraph. Suppress the header for the
  // customer-facing render.
  return (
    <View style={{ marginTop: 4 }}>
      {items.map((it) => (
        <BulletLine key={it.id} text={it.description} />
      ))}
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
              {it.description}
            </Text>
            <Text style={[styles.liCell, styles.liCellQty]}>{it.quantity}</Text>
            <Text style={[styles.liCell, styles.liCellUnit]}>{it.unit}</Text>
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
        <BulletLine key={it.id} text={it.description} />
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
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.sectionUnderlineHeader}>Exclusions &amp; Qualifications:</Text>
      {exclusions.map((ex, i) => (
        <View key={i} style={styles.bulletRow}>
          <View style={styles.bulletDot} />
          <Text style={styles.bulletBody}>{ex}</Text>
        </View>
      ))}
    </View>
  );
}

function EstimatorBlock({ e }: { e: ProposalEstimatorSnapshot }) {
  if (!e.name && !e.email && !e.phone) return null;
  return (
    <View style={styles.estBlock}>
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
  // Karan 2026-07-15: Tomco proposals ALWAYS include the sign-and-return
  // block on customer-facing PDFs. Flip the default so preview / send
  // both include it — the send route can still opt out via ?signature=0
  // if we ever add a "internal review PDF, no sign line" flow.
  showSignatureBlock = true,
}: RenderProposalArgs) {
  const inclusions = lineItems.filter((i) => !i.is_alternate);
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
        {/* Fixed red keyline border wraps every page */}
        <View style={styles.borderFrame} fixed />
        <View style={styles.borderInner} fixed />

        <LogoBlock dateLabel={dateLabel} />
        <SubmittedToBlock h={proposal.header_json} />
        <ProjectBlock h={proposal.header_json} />
        <Text style={styles.intro}>{intro}</Text>

        {showLineTable ? (
          <InclusionsInternal items={inclusions} />
        ) : (
          <InclusionsCustomer items={inclusions} />
        )}

        <TotalRow label={totalLabel} cents={proposal.total_cents} />

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

        <ExclusionsBlock exclusions={exclusions} />

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

        {showSignatureBlock && <SignatureBlock />}

        {/* Estimator sign-off sits BELOW the signature line in Tomco's
            reference PDF, not above the CI notice. */}
        <EstimatorBlock e={proposal.estimator_snapshot_json} />

        {/* Footer fixed to bottom of every page. Rule + text both sit
            INSIDE the red keyline border (bumped in 2026-07-15 fix).
            Rule is a thin red line for visual grounding — matches the
            reference PDF's footer treatment. */}
        <View style={styles.footerRule} fixed />
        <View style={styles.footer} fixed>
          <Text>{TOMCO_COMPANY_FOOTER.address_line}</Text>
          <Text>{TOMCO_COMPANY_FOOTER.contact_line}</Text>
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
