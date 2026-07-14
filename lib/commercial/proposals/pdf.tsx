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
    // Extra bottom padding so footer doesn't overlap content on long
    // multi-page proposals.
    paddingBottom: 68,
    fontSize: 11,
    fontFamily: "Times-Roman",
    color: CHARCOAL,
    lineHeight: 1.35,
  },
  // Red keyline border wraps the whole page (fixed absolute) — Tomco's
  // signature look.
  borderFrame: {
    position: "absolute",
    top: 24,
    left: 28,
    right: 28,
    bottom: 48,
    borderStyle: "solid",
    borderWidth: 1.5,
    borderColor: RED,
  },
  borderInner: {
    position: "absolute",
    top: 28,
    left: 32,
    right: 32,
    bottom: 52,
    borderStyle: "solid",
    borderWidth: 0.5,
    borderColor: RED,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
  },
  logoBlock: {
    flexDirection: "column",
    alignItems: "center",
    flex: 1,
  },
  logoText: {
    fontSize: 26,
    fontFamily: "Times-Bold",
    color: RED,
    letterSpacing: 2,
  },
  logoSub: {
    fontSize: 8,
    color: RED,
    letterSpacing: 3,
    marginTop: 2,
  },
  dateText: {
    fontSize: 11,
    color: CHARCOAL,
    fontFamily: "Times-Roman",
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
  addrLine: {
    fontSize: 11,
    color: CHARCOAL,
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
    marginBottom: 10,
    fontSize: 11,
    lineHeight: 1.4,
  },
  bulletRow: {
    flexDirection: "row",
    marginBottom: 3,
    paddingRight: 4,
  },
  bulletGlyph: {
    width: 12,
    fontSize: 11,
    color: CHARCOAL,
  },
  bulletBody: {
    flex: 1,
    fontSize: 11,
  },
  bulletLead: {
    fontFamily: "Times-Bold",
  },
  totalRow: {
    marginTop: 10,
    marginBottom: 4,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  totalText: {
    fontSize: 12,
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
  ciBanner: {
    marginTop: 14,
    padding: 8,
    backgroundColor: YELLOW_BG,
    borderLeftWidth: 3,
    borderLeftColor: YELLOW_BORDER,
  },
  ciText: {
    fontFamily: "Times-Bold",
    fontSize: 11,
  },
  signBlock: {
    marginTop: 22,
    fontSize: 11,
  },
  signHeading: {
    fontFamily: "Times-Bold",
    marginBottom: 6,
  },
  signLine: {
    fontFamily: "Times-Roman",
    marginTop: 12,
  },
  estBlock: {
    marginTop: 18,
    fontSize: 11,
  },
  estName: {
    fontFamily: "Times-Bold",
    fontSize: 12,
    marginBottom: 2,
  },
  estRow: {
    color: CHARCOAL,
  },
  footer: {
    position: "absolute",
    left: 48,
    right: 48,
    bottom: 28,
    fontSize: 8,
    color: MUTED,
    textAlign: "center",
  },
  pageNumber: {
    position: "absolute",
    right: 48,
    bottom: 14,
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
  const dt = new Date(y, m - 1, d);
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
    <View style={styles.headerRow}>
      {/* Spacer to keep logo center */}
      <View style={{ minWidth: 90 }} />
      <View style={styles.logoBlock}>
        <Text style={styles.logoText}>TOMCO</Text>
        <Text style={styles.logoSub}>PAINTING</Text>
      </View>
      <View>
        <Text style={styles.dateText}>{dateLabel || " "}</Text>
      </View>
    </View>
  );
}

function SubmittedToBlock({ h }: { h: ProposalHeaderJson }) {
  return (
    <View>
      <Text style={styles.sectionUnderlineHeader}>PROPOSAL SUBMITTED TO:</Text>
      {h.gc_company && <Text style={styles.gcName}>{h.gc_company}</Text>}
      {(h.gc_address_lines ?? []).map((line, i) => (
        <Text key={i} style={styles.addrLine}>{line}</Text>
      ))}
      {h.attention && (
        <Text style={styles.addrLine}>Attention: {h.attention}</Text>
      )}
      {h.phone && <Text style={styles.addrLine}>P: {h.phone}</Text>}
      {h.email && (
        <Text style={styles.addrLine}>
          <Text style={styles.link}>{h.email}</Text>
        </Text>
      )}
    </View>
  );
}

function ProjectBlock({ h }: { h: ProposalHeaderJson }) {
  const name = h.project_name?.trim();
  const addr = h.project_address?.trim();
  if (!name && !addr) return null;
  // Single-line variant if only one of the two, or if they're short.
  const inline = name && addr && (name.length + addr.length) < 55;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.sectionUnderlineHeader}>
        PROJECT:{inline ? ` ${name}, ${addr}` : ""}
      </Text>
      {!inline && (
        <>
          {name && <Text style={styles.gcName}>{name}</Text>}
          {addr && <Text style={styles.addrLine}>{addr}</Text>}
        </>
      )}
    </View>
  );
}

function BulletLine({ text }: { text: string }) {
  const { lead, body } = splitBoldLead(text);
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletGlyph}>●</Text>
      <Text style={styles.bulletBody}>
        {lead ? (
          <>
            <Text style={styles.bulletLead}>{lead}:</Text>{" "}
            <Text>{body}</Text>
          </>
        ) : (
          <Text>{body}</Text>
        )}
      </Text>
    </View>
  );
}

function InclusionsCustomer({ items }: { items: CommercialProposalLineItem[] }) {
  if (items.length === 0) return null;
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={styles.sectionUnderlineHeader}>Inclusions:</Text>
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
    <View style={{ marginTop: 12 }}>
      <Text style={styles.sectionUnderlineHeader}>Exclusions:</Text>
      {exclusions.map((ex, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text style={styles.bulletGlyph}>●</Text>
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
      {e.email && (
        <Text style={styles.estRow}>
          <Text style={styles.link}>{e.email}</Text>
        </Text>
      )}
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
        Authorized Client Signature: ________________________________  Date: __________
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
  showSignatureBlock = false,
}: RenderProposalArgs) {
  const inclusions = lineItems.filter((i) => !i.is_alternate);
  const alternates = lineItems.filter((i) => i.is_alternate);
  const totalLabel = proposalTotalLabel(exclusions);
  const intro = proposal.intro_text_override?.trim() || TOMCO_DEFAULT_INTRO;
  const dateLabel = formatDateLong(proposal.header_json.date_iso);

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

        {mode === "internal" ? (
          <InclusionsInternal items={inclusions} />
        ) : (
          <InclusionsCustomer items={inclusions} />
        )}

        <TotalRow label={totalLabel} cents={proposal.total_cents} />

        {mode === "internal" ? (
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

        {/* CIP banner is a customer-facing legal notice — suppress on
            internal-mode PDFs (Alex/Katie estimator-math view) so the
            internal snapshot isn't mistaken for a customer copy. */}
        {mode === "customer" && proposal.header_json.show_capital_improvement_notice && (
          <View style={styles.ciBanner}>
            <Text style={styles.ciText}>
              Subject to Certificate of Capital Improvement or New York State Sales Tax.
            </Text>
          </View>
        )}
        {/* Internal-mode watermark so a screenshot-shared internal PDF
            can't be mistaken for what went to the GC. */}
        {mode === "internal" && (
          <View style={{ marginTop: 14, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: "#FEF3C7", borderLeftWidth: 3, borderLeftColor: "#F59E0B" }}>
            <Text style={{ fontSize: 9, fontFamily: "Times-Bold", color: "#92400E", textTransform: "uppercase", letterSpacing: 1 }}>
              Internal · estimator view · not for customer
            </Text>
          </View>
        )}

        {showSignatureBlock && <SignatureBlock />}

        <EstimatorBlock e={proposal.estimator_snapshot_json} />

        {/* Footer fixed to bottom of every page */}
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
