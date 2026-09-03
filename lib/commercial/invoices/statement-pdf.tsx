import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";
import type { ARStatement } from "./statement";
import { etDateOf } from "@/lib/date-et";

Font.registerHyphenationCallback((word) => [word]);

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 54, paddingHorizontal: 54, fontSize: 10, fontFamily: "Helvetica", color: "#1f2937", lineHeight: 1.4 },
  wordmark: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: 1, textAlign: "center", color: "#172B4D" },
  logoImage: { height: 42, objectFit: "contain", alignSelf: "center", marginBottom: 2 },
  contact: { fontSize: 7.5, textAlign: "center", color: "#9ca3af", marginTop: 3, letterSpacing: 0.3 },
  rule: { borderBottomWidth: 2, borderBottomColor: "#EE662E", marginTop: 12, marginBottom: 18 },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  label: { fontSize: 7.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  bold: { fontFamily: "Helvetica-Bold" },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#111827", paddingBottom: 4, marginBottom: 2 },
  th: { fontSize: 8, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.4, color: "#374151" },
  tr: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  cInv: { width: "18%" },
  cDeal: { width: "34%" },
  cDate: { width: "15%" },
  cDue: { width: "15%" },
  cBal: { width: "18%", textAlign: "right" },
  overdue: { color: "#b91c1c" },
  totalRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10, paddingTop: 8, borderTopWidth: 1.5, borderTopColor: "#111827" },
  agingBox: { marginTop: 24, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 4 },
  agingHead: { flexDirection: "row", backgroundColor: "#f9fafb", borderBottomWidth: 1, borderBottomColor: "#e5e7eb" },
  agingCell: { width: "20%", padding: 6, textAlign: "center" },
  agingLabel: { fontSize: 7, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 },
  footer: { position: "absolute", bottom: 30, left: 54, right: 54, fontSize: 7.5, color: "#9ca3af", textAlign: "center", borderTopWidth: 0.5, borderTopColor: "#e5e7eb", paddingTop: 6 },
  // Bottom-right, clear of the centred footer text above it.
  pageNumber: { position: "absolute", bottom: 16, right: 54, fontSize: 7.5, color: "#9ca3af" },
});

export type CompanyContact = { name: string; phone?: string | null; website?: string | null };

const fmt = (c: number): string =>
  `${c < 0 ? "-" : ""}$${Math.abs(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  // Through etDateOf FIRST. These columns are TIMESTAMPTZ, and slicing the raw
  // ISO string took the UTC calendar day — so a document produced after ~8pm
  // ET was stamped TOMORROW, and disagreed with the same date on screen.
  // etDateOf returns a bare YYYY-MM-DD untouched (a DATE column has no zone to
  // convert), so this is safe for both kinds of column.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(etDateOf(iso) ?? "");
  if (!m) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

function LogoBlock({ company, logo }: { company: CompanyContact; logo?: Buffer | null }) {
  const website = (company.website ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const contact = [company.phone, website].filter(Boolean).join("   ·   ");
  return (
    <View>
      {logo ? <Image src={logo} style={styles.logoImage} /> : <Text style={styles.wordmark}>{company.name}</Text>}
      {contact ? <Text style={styles.contact}>{contact}</Text> : null}
      <View style={styles.rule} />
    </View>
  );
}

function StatementDoc({
  statement,
  accountName,
  billTo,
  company,
  logo,
}: {
  statement: ARStatement;
  accountName: string;
  billTo: string[];
  company: CompanyContact;
  logo?: Buffer | null;
}) {
  const { rows, totalOutstandingCents, retainageHeldCents, aging, generatedAt } = statement;
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <LogoBlock company={company} logo={logo} />

        <View style={styles.row}>
          <View style={{ width: "58%" }}>
            <Text style={styles.label}>Statement for</Text>
            <Text style={styles.bold}>{accountName}</Text>
            {billTo.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={{ width: "38%", textAlign: "right" }}>
            <Text style={styles.h1}>Statement</Text>
            <Text style={[styles.label, { marginTop: 8 }]}>Date</Text>
            <Text style={styles.bold}>{fmtDate(generatedAt)}</Text>
            <Text style={[styles.label, { marginTop: 8 }]}>Total outstanding</Text>
            <Text style={[styles.bold, { fontSize: 14, color: "#172B4D" }]}>{fmt(totalOutstandingCents)}</Text>
          </View>
        </View>

        {rows.length === 0 ? (
          <Text style={{ marginTop: 20, color: "#6b7280" }}>
            {retainageHeldCents > 0
              ? `Nothing currently due — this account has a $0 payable balance. ${fmt(retainageHeldCents)} of retainage is held pending close-out. Thank you.`
              : "No open invoices — this account has a $0 balance. Thank you."}
          </Text>
        ) : (
          <>
            <View style={styles.tableHead} fixed>
              <Text style={[styles.th, styles.cInv]}>Invoice</Text>
              <Text style={[styles.th, styles.cDeal]}>Project</Text>
              <Text style={[styles.th, styles.cDate]}>Issued</Text>
              <Text style={[styles.th, styles.cDue]}>Due</Text>
              <Text style={[styles.th, styles.cBal]}>Balance</Text>
            </View>
            {rows.map((r) => {
              const isOverdue = r.status === "overdue";
              return (
                <View key={r.invoiceId} style={styles.tr} wrap={false}>
                  <Text style={[styles.cInv, styles.bold]}>{r.invoiceNumber}</Text>
                  <Text style={styles.cDeal}>{r.dealName}</Text>
                  <Text style={styles.cDate}>{fmtDate(r.issuedAt)}</Text>
                  <Text style={[styles.cDue, isOverdue ? styles.overdue : {}]}>
                    {fmtDate(r.dueAt)}
                    {isOverdue && r.daysPastDue ? ` (${r.daysPastDue}d)` : ""}
                  </Text>
                  <Text style={[styles.cBal, styles.bold, isOverdue ? styles.overdue : {}]}>{fmt(r.balanceCents)}</Text>
                </View>
              );
            })}
            <View style={styles.totalRow}>
              <Text style={[styles.bold, { marginRight: 12 }]}>Total currently due</Text>
              <Text style={[styles.bold, { fontSize: 12 }]}>{fmt(totalOutstandingCents)}</Text>
            </View>
            {/* Retainage is stated, never summed into the total. It is not
                payable until close-out, so a GC reading this statement must
                see it as a separate obligation — putting it in the total would
                be asking for money the contract doesn't owe yet. */}
            {retainageHeldCents > 0 && (
              <View style={styles.totalRow}>
                <Text style={{ marginRight: 12, color: "#6b7280" }}>
                  Retainage held (due at close-out, not included above)
                </Text>
                <Text style={{ color: "#6b7280" }}>{fmt(retainageHeldCents)}</Text>
              </View>
            )}

            {/* Aging summary */}
            <View style={styles.agingBox} wrap={false}>
              <View style={styles.agingHead}>
                {(["Current", "1–30 days", "31–60 days", "61–90 days", "90+ days"] as const).map((h) => (
                  <View key={h} style={styles.agingCell}>
                    <Text style={styles.agingLabel}>{h}</Text>
                  </View>
                ))}
              </View>
              <View style={{ flexDirection: "row" }}>
                {[aging.current, aging.d1_30, aging.d31_60, aging.d61_90, aging.d90_plus].map((b, i) => (
                  <View key={i} style={styles.agingCell}>
                    <Text style={[styles.bold, i >= 3 && b.cents > 0 ? styles.overdue : {}]}>{fmt(b.cents)}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        <Text style={styles.footer} fixed>
          Statement of account · Please remit the total outstanding. Questions? Reply to this statement or call the number above.
        </Text>

        {/*
          Brendan 2026-09-03 asked for page numbers on the documents that run
          long. This is the one customer-facing document that legitimately does:
          a statement is a ledger, so it lists every open invoice rather than
          being squeezed onto one sheet like the proposal and the transmittals.
          It already repeats the column header across pages; without a number,
          a GC holding three loose sheets cannot tell their order or whether one
          is missing.

          Safe as a react-pdf `fixed render` here precisely BECAUSE this
          document never goes through renderFitToOnePage — in the proposal
          report the identical pattern silently produced nothing, since the fit
          makes totalPages 1 and the extra pages arrive later via pdf-lib.
        */}
        <Text
          style={styles.pageNumber}
          fixed
          render={({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : "")}
        />
      </Page>
    </Document>
  );
}

export async function renderARStatementPdf(input: {
  statement: ARStatement;
  accountName: string;
  billTo: string[];
  company: CompanyContact;
  logo?: Buffer | null;
}): Promise<Buffer> {
  return renderToBuffer(<StatementDoc {...input} />);
}
