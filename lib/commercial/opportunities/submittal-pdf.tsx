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

import type { OpportunitySubmittal } from "./submittals";
import { derivedOppName } from "./db";
import {
  includedKindLabel,
  INCLUDED_KINDS,
  submittalStatusLabel,
  transmittedAsLabel,
  TRANSMITTED_AS_OPTIONS,
} from "./submittal-constants";

/**
 * Letter of Transmittal — React-PDF rendition.
 *
 * Reference: Tomco Painting → Alta Construction submittal package PDF
 * (Katie 2026-06-30). Matches the standard CSI/AIA Letter of Transmittal
 * layout that GCs expect: From/To header + job # + items table + transmission
 * type radio + response section + remarks.
 *
 * Rendered via `renderLetterOfTransmittalPdf` (returns a Buffer) — call from
 * the API download route, NOT from a React component tree.
 *
 * Font: Helvetica (built-in to React-PDF — zero font-file footprint). Avoiding
 * custom font registration on the cold-start path; brand-aligned typography
 * can layer in later via Font.register() if Alex wants.
 *
 * Bundle size: @react-pdf/renderer is ~3-4 MB. Imported only inside the
 * `/api/.../pdf/download` route handler (dynamic import-friendly) so it stays
 * out of every other serverless function bundle.
 */

// Disable React-PDF's font hyphenation — for short fields like "Material Spec
// Sheets" the default hyphenation makes weird breaks.
Font.registerHyphenationCallback((word) => [word]);

// ─── Styles ──────────────────────────────────────────────────────────

const colors = {
  charcoal: "#1F2937",   // matches Tailwind ppp-charcoal
  muted: "#6B7280",
  border: "#E5E7EB",
  brand: "#10B981",      // emerald-600
  brandDeep: "#047857",
  rose: "#B91C1C",
  amber: "#92400E",
  bgSubtle: "#F9FAFB",
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingHorizontal: 40,
    // Extra bottom padding so the absolutely-positioned footer doesn't
    // overlap content on dense multi-page submittals (audit PDF #C4).
    paddingBottom: 60,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: colors.charcoal,
    lineHeight: 1.4,
  },
  // Header band
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 2,
    borderBottomColor: colors.brand,
  },
  brand: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: colors.brandDeep,
    letterSpacing: 1.5,
  },
  brandSub: {
    fontSize: 8,
    color: colors.muted,
    marginTop: 2,
  },
  titleBlock: { alignItems: "flex-end" },
  title: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  subNumber: {
    fontSize: 10,
    color: colors.muted,
    marginTop: 2,
  },
  // Meta grid (To / Job# / Date / Attention / RE)
  metaGrid: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 16,
  },
  metaCol: { flex: 1 },
  metaBox: {
    borderWidth: 1,
    borderColor: colors.border,
    padding: 8,
    borderRadius: 3,
    marginBottom: 8,
  },
  metaLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  metaValue: { fontSize: 11, color: colors.charcoal },
  metaValueMono: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: colors.charcoal,
  },
  // Sections
  sectionLabel: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 12,
    marginBottom: 6,
  },
  // Included-kinds + transmitted-as: pseudo-checkbox rows
  checkboxRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 4,
  },
  checkbox: {
    flexDirection: "row",
    alignItems: "center",
    width: "32%",
    marginBottom: 4,
  },
  checkboxBox: {
    width: 10,
    height: 10,
    borderWidth: 1,
    borderColor: colors.charcoal,
    marginRight: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxBoxChecked: {
    width: 10,
    height: 10,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.brand,
    marginRight: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  checkmark: { color: "white", fontSize: 8, fontFamily: "Helvetica-Bold" },
  checkboxLabel: { fontSize: 9 },
  // Items table
  table: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: colors.bgSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    padding: 6,
  },
  tableHeaderCell: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    padding: 6,
  },
  tableRowLast: {
    flexDirection: "row",
    padding: 6,
  },
  // Columns: Copies (10%) / Date (15%) / # (15%) / Description (45%) / Finish (15%)
  colCopies: { width: "10%", textAlign: "center" },
  colDate: { width: "15%" },
  colNumber: { width: "15%" },
  colDesc: { width: "45%" },
  colFinish: { width: "15%" },
  tableCell: { fontSize: 9 },
  emptyRow: {
    padding: 12,
    textAlign: "center",
    color: colors.muted,
    fontSize: 9,
  },
  // Remarks + footer
  remarksBox: {
    marginTop: 12,
    padding: 8,
    backgroundColor: colors.bgSubtle,
    borderRadius: 3,
    borderLeftWidth: 3,
    borderLeftColor: colors.brand,
  },
  remarksLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  remarksBody: { fontSize: 10, lineHeight: 1.5 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 6,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: { fontSize: 7, color: colors.muted },
  // Status pill (top-right)
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  statusPillEmerald: { backgroundColor: "#D1FAE5", color: "#065F46" },
  statusPillAmber: { backgroundColor: "#FEF3C7", color: colors.amber },
  statusPillRose: { backgroundColor: "#FEE2E2", color: colors.rose },
  statusPillSky: { backgroundColor: "#DBEAFE", color: "#1E40AF" },
  statusPillNeutral: { backgroundColor: "#F3F4F6", color: colors.charcoal },
  // VOIDED watermark — diagonal text overlay on every page so a printed
  // copy of a voided submittal can't be mistaken for the real package
  // (audit PDF #S1, 2026-06-30).
  voidWatermark: {
    position: "absolute",
    top: "40%",
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 90,
    fontFamily: "Helvetica-Bold",
    color: "#FEE2E2",
    opacity: 0.6,
    transform: "rotate(-25deg)",
    letterSpacing: 8,
  },
});

// ─── Component ───────────────────────────────────────────────────────

type SubmittalPdfInput = {
  submittal: OpportunitySubmittal;
  items: Array<{
    position: number;
    copies: number;
    item_date: string | null;
    item_number: string | null;
    description: string;
    finish_code: string | null;
  }>;
  opp: {
    title: string;
    ppp_job_number: string | null;
    // Phase B: structural fields so the transmittal PDF matches what
    // users see in the UI. Nullable — legacy rows fall back to title.
    client_name?: string | null;
    location_short?: string | null;
  };
  accountName?: string | null;
  fromCompany: string; // PPP entity name — hardcoded for now, could be tenant-configurable
};

// Source-of-truth arrays come from submittal-constants.ts. Don't
// duplicate them here — adding a new kind there would silently drift
// otherwise (audit backend H1, 2026-06-30).

function safeDateLabel(value: string | null | undefined, fmt: Intl.DateTimeFormatOptions): string {
  if (!value) return "—";
  // Defend against "0000-00-00" sentinel — JS parses it as a BC year not
  // NaN, which would render as "12/31/00" or similar nonsense.
  if (value.startsWith("0000")) return "—";
  // Bare YYYY-MM-DD parses as UTC midnight. With `timeZone: "America/New_York"`
  // (UTC-4/5), that displays as the PREVIOUS day for any user east of UTC —
  // every item_date stored as a Postgres DATE would show off by one. Detect
  // and append T12:00:00 (noon UTC) so the ET conversion lands the right day
  // year-round (audit recheck 2026-06-30).
  const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(isoDateOnly ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York", ...fmt });
}

function LetterOfTransmittalDocument({ submittal, items, opp, accountName, fromCompany }: SubmittalPdfInput) {
  const issueDate = submittal.sent_at ?? submittal.created_at;
  const dateLabel = safeDateLabel(issueDate, { year: "numeric", month: "long", day: "numeric" });
  const submittalNumber = `SUB-${String(submittal.submittal_number).padStart(3, "0")}${
    submittal.revision_number > 0 ? ` Rev ${submittal.revision_number}` : ""
  }`;
  const includedSet = new Set(submittal.included_kinds);
  const isDraft = submittal.status === "draft";
  const isVoided = submittal.status === "voided";
  const isRejected = submittal.status === "rejected";
  const isApproved =
    submittal.status === "approved" ||
    submittal.status === "approved_as_noted" ||
    submittal.status === "closed";
  const isRevise = submittal.status === "revise_and_resubmit";
  // "submitted" + "under_review" get a sky pill so a printed package is
  // unambiguous about which side of the GC court it sits on (audit
  // recheck 2026-06-30 — previously these printed with NO pill, looked
  // identical to a fresh draft on paper).
  const isInFlight = submittal.status === "submitted" || submittal.status === "under_review";
  const statusStyle = isApproved
    ? styles.statusPillEmerald
    : isRevise
    ? styles.statusPillAmber
    : isRejected || isVoided
    ? styles.statusPillRose
    : isInFlight
    ? styles.statusPillSky
    : styles.statusPillNeutral;

  const addrLines = submittal.to_address_lines ?? [];

  return (
    <Document
      title={`Letter of Transmittal — ${submittalNumber}`}
      author={fromCompany}
      subject={submittal.re_subject ?? "Submittals"}
    >
      <Page size="LETTER" style={styles.page}>
        {/* VOIDED watermark — diagonal text overlay on every page so a
            printed voided submittal can't be mistaken for the real one
            (audit PDF #S1). `fixed` repeats on each page. */}
        {isVoided && (
          <Text style={styles.voidWatermark} fixed>VOIDED</Text>
        )}

        {/* Header band */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.brand}>{fromCompany.toUpperCase()}</Text>
            <Text style={styles.brandSub}>Commercial Painting</Text>
          </View>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Letter of Transmittal</Text>
            <Text style={styles.subNumber}>{submittalNumber}</Text>
            {/* Status pill — render for ANY non-default state. DRAFT
                gets a visible amber pill (audit PDF #L1) so a printed
                draft can't be mistaken for the real package; previously
                it was a muted text suffix that disappeared at glance. */}
            {isDraft && (
              <View style={{ marginTop: 4 }}>
                <Text style={[styles.statusPill, styles.statusPillAmber]}>Draft · not yet sent</Text>
              </View>
            )}
            {(isVoided || isApproved || isRejected || isRevise || isInFlight) && (
              <View style={{ marginTop: 4 }}>
                <Text style={[styles.statusPill, statusStyle]}>{submittalStatusLabel(submittal.status)}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Meta grid: 2 columns */}
        <View style={styles.metaGrid}>
          <View style={styles.metaCol}>
            <View style={styles.metaBox}>
              <Text style={styles.metaLabel}>To</Text>
              <Text style={styles.metaValueMono}>{submittal.to_company ?? "—"}</Text>
              {addrLines.map((line, i) => (
                <Text key={i} style={styles.metaValue}>{line}</Text>
              ))}
            </View>
            <View style={styles.metaBox}>
              <Text style={styles.metaLabel}>Attention</Text>
              <Text style={styles.metaValue}>{submittal.to_attention ?? "—"}</Text>
            </View>
          </View>
          <View style={styles.metaCol}>
            <View style={styles.metaBox}>
              <Text style={styles.metaLabel}>Date</Text>
              <Text style={styles.metaValueMono}>{dateLabel}</Text>
            </View>
            <View style={styles.metaBox}>
              <Text style={styles.metaLabel}>Job no.</Text>
              <Text style={styles.metaValueMono}>{opp.ppp_job_number ?? "—"}</Text>
              <Text style={styles.metaValue}>{derivedOppName({ title: opp.title, client_name: opp.client_name ?? null, location_short: opp.location_short ?? null }, accountName ?? null)}</Text>
            </View>
            <View style={styles.metaBox}>
              <Text style={styles.metaLabel}>RE</Text>
              <Text style={styles.metaValue}>{submittal.re_subject ?? "Submittals"}</Text>
            </View>
          </View>
        </View>

        {/* WE ARE SENDING YOU — checkbox row */}
        <Text style={styles.sectionLabel}>We are sending you</Text>
        <View style={styles.checkboxRow}>
          {INCLUDED_KINDS.map((kind) => {
            const checked = includedSet.has(kind);
            return (
              <View key={kind} style={styles.checkbox}>
                <View style={checked ? styles.checkboxBoxChecked : styles.checkboxBox}>
                  {checked && <Text style={styles.checkmark}>X</Text>}
                </View>
                <Text style={styles.checkboxLabel}>{includedKindLabel(kind)}</Text>
              </View>
            );
          })}
        </View>

        {/* Items table */}
        <Text style={styles.sectionLabel}>Items transmitted</Text>
        <View style={styles.table}>
          {/* `fixed` re-renders the header on every page when the table
              spans pages (audit PDF #C3). Without it, page 2+ has
              orphaned rows with no column labels. */}
          <View style={styles.tableHeader} fixed>
            <Text style={[styles.tableHeaderCell, styles.colCopies]}>Copies</Text>
            <Text style={[styles.tableHeaderCell, styles.colDate]}>Date</Text>
            <Text style={[styles.tableHeaderCell, styles.colNumber]}>Ref #</Text>
            <Text style={[styles.tableHeaderCell, styles.colDesc]}>Description</Text>
            <Text style={[styles.tableHeaderCell, styles.colFinish]}>Finish code</Text>
          </View>
          {items.length === 0 ? (
            <Text style={styles.emptyRow}>(no items)</Text>
          ) : (
            items.map((item, i) => {
              const last = i === items.length - 1;
              return (
                /* `wrap={false}` keeps a row atomic — never split across
                    pages mid-description, which looks broken to a GC
                    (audit PDF #C3). */
                <View key={i} style={last ? styles.tableRowLast : styles.tableRow} wrap={false}>
                  <Text style={[styles.tableCell, styles.colCopies]}>{item.copies}</Text>
                  <Text style={[styles.tableCell, styles.colDate]}>
                    {safeDateLabel(item.item_date, { month: "numeric", day: "numeric", year: "2-digit" })}
                  </Text>
                  <Text style={[styles.tableCell, styles.colNumber]}>{item.item_number ?? "—"}</Text>
                  <Text style={[styles.tableCell, styles.colDesc]}>{item.description}</Text>
                  <Text style={[styles.tableCell, styles.colFinish]}>{item.finish_code ?? ""}</Text>
                </View>
              );
            })
          )}
        </View>

        {/* THESE ARE TRANSMITTED */}
        <Text style={styles.sectionLabel}>These are transmitted</Text>
        <View style={styles.checkboxRow}>
          {TRANSMITTED_AS_OPTIONS.map((key) => {
            const checked = submittal.transmitted_as === key;
            return (
              <View key={key} style={styles.checkbox}>
                <View style={checked ? styles.checkboxBoxChecked : styles.checkboxBox}>
                  {checked && <Text style={styles.checkmark}>X</Text>}
                </View>
                <Text style={styles.checkboxLabel}>{transmittedAsLabel(key)}</Text>
              </View>
            );
          })}
        </View>

        {/* Remarks */}
        {submittal.remarks && (
          <View style={styles.remarksBox}>
            <Text style={styles.remarksLabel}>Remarks</Text>
            <Text style={styles.remarksBody}>{submittal.remarks}</Text>
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {fromCompany} · Generated by Commercial Command Center
          </Text>
          <Text style={styles.footerText}>{submittalNumber}</Text>
        </View>
      </Page>
    </Document>
  );
}

/**
 * Render a Letter of Transmittal PDF for the given submittal + items.
 * Returns a Buffer ready to stream to the client.
 *
 * Call this from the API download route, not from RSC — React-PDF needs
 * the Node runtime + ~300-500ms cold start to spin up the renderer.
 */
export async function renderLetterOfTransmittalPdf(
  input: SubmittalPdfInput
): Promise<Buffer> {
  // React-PDF's renderToBuffer types are over-narrow on FC elements; the
  // component IS a <Document>, so the runtime contract holds. The cast
  // is the documented escape hatch (see @react-pdf/renderer issue #2730).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await renderToBuffer(React.createElement(LetterOfTransmittalDocument, input) as any);
}

// Display-name + export for testability
LetterOfTransmittalDocument.displayName = "LetterOfTransmittalDocument";
export { LetterOfTransmittalDocument };
