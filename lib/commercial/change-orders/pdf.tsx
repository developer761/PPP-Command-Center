import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";

Font.registerHyphenationCallback((word) => [word]);

/**
 * Standalone Change Order document to the GC (Katie's doc set). A GC often wants
 * a signed CO to authorize the extra/credit before it's billed. Same Tomco
 * letterhead as the invoice/statement so it reads as one company. Shows the
 * change, the dollar impact (signed), and the contract adjustment (prior →
 * revised), then an acceptance block: the contractor's stored signature (Brendan
 * tap-to-sign) + a line for the GC to authorize.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 64, paddingHorizontal: 54, fontSize: 10, fontFamily: "Helvetica", color: "#1f2937", lineHeight: 1.45 },
  wordmark: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: 1, textAlign: "center", color: "#172B4D" },
  logoImage: { height: 42, objectFit: "contain", alignSelf: "center", marginBottom: 2 },
  contact: { fontSize: 7.5, textAlign: "center", color: "#9ca3af", marginTop: 3, letterSpacing: 0.3 },
  rule: { borderBottomWidth: 2, borderBottomColor: "#EE662E", marginTop: 12, marginBottom: 18 },
  h1: { fontSize: 15, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1.5, color: "#172B4D" },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  label: { fontSize: 7.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  metaLabel: { fontSize: 7.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 },
  metaVal: { fontFamily: "Helvetica-Bold", marginBottom: 5 },
  bold: { fontFamily: "Helvetica-Bold" },
  sectionLabel: { fontSize: 8, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.6, color: "#374151", marginBottom: 4, marginTop: 6 },
  descBox: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 4, padding: 10, marginBottom: 4 },
  adjRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  adjLabel: { color: "#4b5563" },
  adjTotal: { flexDirection: "row", justifyContent: "space-between", paddingTop: 7, marginTop: 3, borderTopWidth: 1.5, borderTopColor: "#111827" },
  amountBox: { flexDirection: "row", justifyContent: "space-between", marginTop: 8, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 10 },
  amountLabel: { color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  amountVal: { color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 13 },
  signWrap: { flexDirection: "row", justifyContent: "space-between", marginTop: 34, gap: 24 },
  signCol: { width: "46%" },
  sigImage: { height: 34, objectFit: "contain", marginBottom: 2, alignSelf: "flex-start" },
  sigLine: { borderTopWidth: 1, borderTopColor: "#111827", marginTop: 24, paddingTop: 3 },
  sigMeta: { fontSize: 8, color: "#6b7280" },
  footer: { position: "absolute", bottom: 30, left: 54, right: 54, fontSize: 7.5, color: "#9ca3af", textAlign: "center", borderTopWidth: 0.5, borderTopColor: "#e5e7eb", paddingTop: 6 },
});

export type ChangeOrderPdfCompany = {
  name: string;
  phone?: string | null;
  website?: string | null;
  signature_name?: string | null;
  signature_title?: string | null;
};

export type ChangeOrderPdfInput = {
  coNumber: string;
  title: string;
  description: string | null;
  /** Signed: positive = added scope, negative = credit/deduct. */
  amountCents: number;
  isDeduct: boolean;
  status: string;
  dateIso: string | null;
  accountName: string;
  billTo: string[];
  dealName: string | null;
  priorContractCents: number | null;
  revisedContractCents: number | null;
  company: ChangeOrderPdfCompany;
  logo?: Buffer | null;
  /** Contractor's stored signature image (Brendan tap-to-sign), if on file. */
  signature?: Buffer | null;
};

const fmt = (c: number): string =>
  `${c < 0 ? "-" : ""}$${Math.abs(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (c: number): string => `${c < 0 ? "−" : "+"}${fmt(Math.abs(c))}`;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

function ChangeOrderDoc(input: ChangeOrderPdfInput) {
  const website = (input.company.website ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const headerContact = [input.company.phone, website].filter(Boolean).join("   ·   ");
  const barColor = input.isDeduct ? "#b91c1c" : "#172B4D";
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View>
          {input.logo ? <Image src={input.logo} style={styles.logoImage} /> : <Text style={styles.wordmark}>{input.company.name}</Text>}
          {headerContact ? <Text style={styles.contact}>{headerContact}</Text> : null}
          <View style={styles.rule} />
        </View>

        <View style={styles.row}>
          <View style={{ width: "56%" }}>
            <Text style={styles.label}>To</Text>
            <Text style={styles.bold}>{input.accountName}</Text>
            {input.billTo.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
            {input.dealName ? (
              <>
                <Text style={[styles.label, { marginTop: 8 }]}>Project</Text>
                <Text>{input.dealName}</Text>
              </>
            ) : null}
          </View>
          <View style={{ width: "40%", textAlign: "right" }}>
            <Text style={styles.h1}>Change Order</Text>
            <View style={{ marginTop: 10 }}>
              <Text style={styles.metaLabel}>Change order #</Text>
              <Text style={styles.metaVal}>{input.coNumber}</Text>
              <Text style={styles.metaLabel}>Date</Text>
              <Text style={styles.metaVal}>{fmtDate(input.dateIso)}</Text>
              <Text style={styles.metaLabel}>Status</Text>
              <Text style={styles.metaVal}>{input.status}</Text>
            </View>
          </View>
        </View>

        {/* The change */}
        <Text style={styles.sectionLabel}>Description of change</Text>
        <View style={styles.descBox}>
          <Text style={styles.bold}>{input.title}</Text>
          {input.description ? <Text style={{ marginTop: 3 }}>{input.description}</Text> : null}
        </View>

        {/* Dollar impact */}
        <View style={[styles.amountBox, { backgroundColor: barColor }]}>
          <Text style={styles.amountLabel}>{input.isDeduct ? "Credit to contract" : "Add to contract"}</Text>
          <Text style={styles.amountVal}>{signed(input.amountCents)}</Text>
        </View>

        {/* Contract adjustment (when the contract is known) */}
        {input.priorContractCents != null && input.revisedContractCents != null ? (
          <View style={{ marginTop: 18 }}>
            <Text style={styles.sectionLabel}>Contract adjustment</Text>
            <View style={styles.adjRow}>
              <Text style={styles.adjLabel}>Contract sum prior to this change order</Text>
              <Text>{fmt(input.priorContractCents)}</Text>
            </View>
            <View style={styles.adjRow}>
              <Text style={styles.adjLabel}>This change order</Text>
              <Text style={input.isDeduct ? { color: "#b91c1c" } : {}}>{signed(input.amountCents)}</Text>
            </View>
            <View style={styles.adjTotal}>
              <Text style={styles.bold}>Revised contract sum</Text>
              <Text style={styles.bold}>{fmt(input.revisedContractCents)}</Text>
            </View>
          </View>
        ) : null}

        {/* Acceptance */}
        <View style={styles.signWrap} wrap={false}>
          <View style={styles.signCol}>
            <Text style={styles.label}>Contractor</Text>
            {input.signature ? <Image src={input.signature} style={styles.sigImage} /> : null}
            <View style={styles.sigLine}>
              <Text style={styles.sigMeta}>
                {input.company.signature_name || input.company.name}
                {input.company.signature_title ? `, ${input.company.signature_title}` : ""}
              </Text>
              <Text style={styles.sigMeta}>{input.company.name}</Text>
            </View>
          </View>
          <View style={styles.signCol}>
            <Text style={styles.label}>Accepted by (Owner / GC)</Text>
            <View style={styles.sigLine}>
              <Text style={styles.sigMeta}>Signature</Text>
            </View>
            <View style={[styles.sigLine, { marginTop: 22 }]}>
              <Text style={styles.sigMeta}>Print name / Date</Text>
            </View>
          </View>
        </View>

        <Text style={styles.footer} fixed>
          This change order adjusts the contract sum as shown above. Please sign and return to authorize.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderChangeOrderPdf(input: ChangeOrderPdfInput): Promise<Buffer> {
  return renderToBuffer(<ChangeOrderDoc {...input} />);
}
