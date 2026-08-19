import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";
import { etDateOf, isPastEt } from "@/lib/date-et";

Font.registerHyphenationCallback((word) => [word]);

/**
 * Branded invoice PDF — the document Tomco emails to a GC (Katie 2026-08). Mirrors
 * the AR-statement letterhead (logo + orange keyline + operating-company contact)
 * so every outbound doc reads as one company. Bill-to = the account; remit-to =
 * the operating company (check payable + address); CO lines are marked; a
 * tax-exempt job prints its certificate number in place of a tax amount.
 *
 * Pure presentation — the caller assembles `rows` from either the invoice's line
 * items OR its milestones (an invoice is one or the other), so this component
 * never has to know which billing shape it's rendering.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 64, paddingHorizontal: 54, fontSize: 10, fontFamily: "Helvetica", color: "#1f2937", lineHeight: 1.4 },
  wordmark: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: 1, textAlign: "center", color: "#172B4D" },
  logoImage: { height: 42, objectFit: "contain", alignSelf: "center", marginBottom: 2 },
  contact: { fontSize: 7.5, textAlign: "center", color: "#9ca3af", marginTop: 3, letterSpacing: 0.3 },
  rule: { borderBottomWidth: 2, borderBottomColor: "#EE662E", marginTop: 12, marginBottom: 18 },
  h1: { fontSize: 15, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1.5, color: "#172B4D" },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  label: { fontSize: 7.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  bold: { fontFamily: "Helvetica-Bold" },
  metaLabel: { fontSize: 7.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 },
  metaVal: { fontFamily: "Helvetica-Bold", marginBottom: 5 },
  overdue: { color: "#b91c1c" },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#111827", paddingBottom: 4, marginBottom: 2 },
  th: { fontSize: 8, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.4, color: "#374151" },
  tr: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  cDesc: { width: "52%", paddingRight: 8 },
  cQty: { width: "12%", textAlign: "right" },
  cUnit: { width: "18%", textAlign: "right" },
  cAmt: { width: "18%", textAlign: "right" },
  coTag: { fontSize: 7, color: "#c2410c", fontFamily: "Helvetica-Bold", letterSpacing: 0.3 },
  totalsWrap: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },
  totalsBox: { width: "48%" },
  totLine: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  totLabel: { color: "#4b5563" },
  // ── Financial Summary (Brendan's format, 2026-08-19) ──
  fsHead: { fontSize: 10, fontFamily: "Helvetica-Bold", color: "#172B4D", marginTop: 16, marginBottom: 5, paddingBottom: 3, borderBottomWidth: 0.75, borderBottomColor: "#d1d5db" },
  fsRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: "#f3f4f6" },
  fsIndent: { paddingLeft: 12, color: "#4b5563", fontSize: 9 },
  fsStrong: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderTopWidth: 1, borderTopColor: "#111827", marginTop: 2 },
  fsCredit: { color: "#b91c1c" },
  fsNote: { fontSize: 7.5, color: "#9ca3af", marginTop: 5, lineHeight: 1.4 },
  fsMeta: { flexDirection: "row", marginBottom: 2 },
  fsMetaLabel: { width: 92, color: "#6b7280" },
  grandLine: { flexDirection: "row", justifyContent: "space-between", paddingTop: 7, marginTop: 4, borderTopWidth: 1.5, borderTopColor: "#111827" },
  balanceBox: { flexDirection: "row", justifyContent: "space-between", marginTop: 8, backgroundColor: "#172B4D", borderRadius: 4, paddingVertical: 8, paddingHorizontal: 10 },
  balanceLabel: { color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  balanceVal: { color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 13 },
  msgBox: { marginTop: 20, borderLeftWidth: 3, borderLeftColor: "#EE662E", paddingLeft: 10 },
  remitBox: { marginTop: 22, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 4, padding: 10, backgroundColor: "#f9fafb" },
  footer: { position: "absolute", bottom: 30, left: 54, right: 54, fontSize: 7.5, color: "#9ca3af", textAlign: "center", borderTopWidth: 0.5, borderTopColor: "#e5e7eb", paddingTop: 6 },
  // VOIDED watermark — same treatment the submittal PDF uses. A voided invoice
  // still has to be printable as a record, but a printed copy must never be
  // mistakable for a live bill: the route rendered one that looked completely
  // payable, balance box and all.
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

export type CompanyRemit = {
  name: string;
  legal_name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
};

export type InvoicePdfRow = {
  description: string;
  quantity: number;
  unit: string | null;
  unitPriceCents: number;
  amountCents: number;
  isChangeOrder?: boolean;
};

export type InvoicePdfInput = {
  invoiceNumber: string;
  issuedAt: string | null;
  dueAt: string | null;
  poNumber: string | null;
  paymentTerms: string | null;
  customerMessage: string | null;
  subtotalCents: number;
  taxPct: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  /** Tax certificate number when the JOB is exempt; null → normal tax line. */
  taxExemptCertNumber: string | null;
  isTaxExempt: boolean;
  accountName: string;
  /** Bill-to address lines (already assembled, no empties). */
  billTo: string[];
  dealName: string | null;
  rows: InvoicePdfRow[];
  company: CompanyRemit;
  logo?: Buffer | null;
  /** Voided invoices still render (as a record) but are stamped VOIDED. */
  isVoid?: boolean;
  /**
   * JOB-level contract position — the "Financial Summary" block in Brendan's
   * format (Stephanie 2026-08-19). Null when the job has no contract figure to
   * reconcile against, in which case the invoice renders as a plain line-item
   * bill rather than printing a summary built on a zero.
   *
   * Deliberately job-level, not invoice-level: the sample reconciles the WHOLE
   * job (original contract + change orders − everything paid so far), then
   * states this invoice's amount against it. That's the number a GC's AP
   * department checks, and it's what Stephanie meant by "a lot of details are
   * missing on the existing".
   */
  contract?: {
    originalCents: number;
    /** APPROVED change orders only — see the note in the renderer. */
    changeOrders: { number: number; title: string; amountCents: number }[];
    changeOrderTotalCents: number;
    totalChargesCents: number;
    /** Every payment across the JOB, newest last. */
    payments: { dateIso: string | null; amountCents: number }[];
    paymentsTotalCents: number;
    currentBalanceCents: number;
    /** Approved COs raised but not yet on any invoice — money still to bill. */
    pendingCoTotalCents: number;
  } | null;
  /** Job number for the Project Information block. */
  jobNumber?: string | null;
  /** Who the invoice goes to at the GC. */
  billingContact?: string | null;
  projectAddress?: string | null;
};

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

function fmtQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}

function remitLines(c: CompanyRemit): string[] {
  const out: string[] = [];
  const payTo = c.legal_name?.trim() || c.name;
  out.push(`Make checks payable to: ${payTo}`);
  const street = [c.address_line1, c.address_line2].map((s) => s?.trim()).filter(Boolean).join(", ");
  const cityLine = [[c.city?.trim(), c.state?.trim()].filter(Boolean).join(", "), c.zip?.trim()].filter(Boolean).join(" ");
  const addr = [street, cityLine].filter(Boolean).join(" · ");
  if (addr) out.push(`Remit to: ${addr}`);
  const contact = [c.phone?.trim(), c.email?.trim()].filter(Boolean).join("   ·   ");
  if (contact) out.push(contact);
  return out;
}

function InvoiceDoc(input: InvoicePdfInput) {
  const website = (input.company.website ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const headerContact = [input.company.phone, website].filter(Boolean).join("   ·   ");
  // ET CALENDAR days, not a raw instant compare. `new Date(dueAt) < new Date()`
  // flipped an invoice to red "overdue" at midday on its own due date — the
  // exact bug isInvoiceOverdue was written to fix, re-introduced here. An
  // invoice is not late until the day AFTER it was due.
  const dueDay = etDateOf(input.dueAt);
  const overdue = input.balanceCents > 0 && !!dueDay && isPastEt(dueDay);
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {input.isVoid ? (
          <Text style={styles.voidWatermark} fixed>
            VOIDED
          </Text>
        ) : null}
        {/* Letterhead */}
        <View>
          {input.logo ? <Image src={input.logo} style={styles.logoImage} /> : <Text style={styles.wordmark}>{input.company.name}</Text>}
          {headerContact ? <Text style={styles.contact}>{headerContact}</Text> : null}
          <View style={styles.rule} />
        </View>

        {/* Bill-to + invoice meta */}
        <View style={styles.row}>
          <View style={{ width: "56%" }}>
            <Text style={styles.label}>Bill to</Text>
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
            <Text style={styles.h1}>Invoice</Text>
            <View style={{ marginTop: 10 }}>
              <Text style={styles.metaLabel}>Invoice #</Text>
              <Text style={styles.metaVal}>{input.invoiceNumber}</Text>
              <Text style={styles.metaLabel}>Issued</Text>
              <Text style={styles.metaVal}>{fmtDate(input.issuedAt)}</Text>
              <Text style={styles.metaLabel}>Due</Text>
              <Text style={[styles.metaVal, overdue ? styles.overdue : {}]}>{fmtDate(input.dueAt)}</Text>
              {input.poNumber ? (
                <>
                  <Text style={styles.metaLabel}>PO #</Text>
                  <Text style={styles.metaVal}>{input.poNumber}</Text>
                </>
              ) : null}
            </View>
          </View>
        </View>

        {/* ── Financial Summary ────────────────────────────────────────────
            Brendan's format (via Stephanie, 2026-08-19). Reconciles the WHOLE
            job — original contract + approved change orders, less everything
            paid — then the line items below state what THIS invoice bills.
            Stephanie's note was that the Salesforce format was missing "a lot
            of details"; this is the detail a GC's AP department checks. ── */}
        {input.contract ? (
          <View>
            <Text style={styles.fsHead}>Project Information</Text>
            <View style={{ marginBottom: 6 }}>
              <View style={styles.fsMeta}>
                <Text style={styles.fsMetaLabel}>Client:</Text>
                <Text>{input.accountName}</Text>
              </View>
              {input.jobNumber ? (
                <View style={styles.fsMeta}>
                  <Text style={styles.fsMetaLabel}>Job #:</Text>
                  <Text>{input.jobNumber}</Text>
                </View>
              ) : null}
              {input.projectAddress ? (
                <View style={styles.fsMeta}>
                  <Text style={styles.fsMetaLabel}>Project Address:</Text>
                  <Text>{input.projectAddress}</Text>
                </View>
              ) : null}
            </View>

            <Text style={styles.fsHead}>Financial Summary</Text>
            <View style={styles.fsRow}>
              <Text>Original Contract Total</Text>
              <Text>{fmt(input.contract.originalCents)}</Text>
            </View>
            {input.contract.changeOrders.map((co) => (
              <View key={co.number} style={styles.fsRow}>
                <Text style={styles.fsIndent}>
                  CO #{co.number} - {co.title.length > 58 ? `${co.title.slice(0, 58)}...` : co.title}
                </Text>
                <Text style={styles.fsIndent}>{fmt(co.amountCents)}</Text>
              </View>
            ))}
            {input.contract.changeOrders.length > 0 ? (
              <View style={styles.fsRow}>
                <Text>Change Order Total</Text>
                <Text>{fmt(input.contract.changeOrderTotalCents)}</Text>
              </View>
            ) : null}
            <View style={styles.fsStrong}>
              <Text style={styles.bold}>Total Customer Charges</Text>
              <Text style={styles.bold}>{fmt(input.contract.totalChargesCents)}</Text>
            </View>
            {input.contract.payments.map((pm, i) => (
              <View key={i} style={styles.fsRow}>
                <Text style={[styles.fsIndent, styles.fsCredit]}>
                  Payment{pm.dateIso ? ` - ${fmtDate(pm.dateIso)}` : ""}
                </Text>
                <Text style={[styles.fsIndent, styles.fsCredit]}>{fmt(-pm.amountCents)}</Text>
              </View>
            ))}
            {input.contract.payments.length > 0 ? (
              <View style={styles.fsRow}>
                <Text style={styles.fsCredit}>Payments Received Total</Text>
                <Text style={styles.fsCredit}>{fmt(-input.contract.paymentsTotalCents)}</Text>
              </View>
            ) : null}
            <View style={styles.fsStrong}>
              <Text style={styles.bold}>
                {input.contract.currentBalanceCents < 0 ? "Credit Balance" : "Current Balance"}
              </Text>
              <Text style={styles.bold}>{fmt(input.contract.currentBalanceCents)}</Text>
            </View>
            {/* A pending CO is money the GC has NOT agreed to, so it is kept
                out of Total Customer Charges — but leaving it unsaid makes the
                contract look smaller than the job actually is. */}
            {input.contract.pendingCoTotalCents !== 0 ? (
              <Text style={styles.fsNote}>
                Excludes {fmt(input.contract.pendingCoTotalCents)} of change orders awaiting your
                approval. They are added to the contract once approved.
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Line items — what THIS invoice bills. */}
        {input.contract ? <Text style={styles.fsHead}>This Invoice Includes</Text> : null}
        <View style={styles.tableHead} fixed>
          <Text style={[styles.th, styles.cDesc]}>Description</Text>
          <Text style={[styles.th, styles.cQty]}>Qty</Text>
          <Text style={[styles.th, styles.cUnit]}>Unit price</Text>
          <Text style={[styles.th, styles.cAmt]}>Amount</Text>
        </View>
        {input.rows.length === 0 ? (
          <Text style={{ marginTop: 10, color: "#6b7280" }}>No line items on this invoice.</Text>
        ) : (
          input.rows.map((r, i) => (
            <View key={i} style={styles.tr} wrap={false}>
              <View style={styles.cDesc}>
                <Text>{r.description}</Text>
                {r.isChangeOrder ? <Text style={styles.coTag}>CHANGE ORDER</Text> : null}
              </View>
              <Text style={styles.cQty}>{fmtQty(r.quantity)}{r.unit ? ` ${r.unit}` : ""}</Text>
              <Text style={styles.cUnit}>{fmt(r.unitPriceCents)}</Text>
              <Text style={[styles.cAmt, r.amountCents < 0 ? { color: "#b91c1c" } : {}]}>{fmt(r.amountCents)}</Text>
            </View>
          ))
        )}

        {/* Totals */}
        <View style={styles.totalsWrap} wrap={false}>
          <View style={styles.totalsBox}>
            <View style={styles.totLine}>
              <Text style={styles.totLabel}>Subtotal</Text>
              <Text>{fmt(input.subtotalCents)}</Text>
            </View>
            <View style={styles.totLine}>
              <Text style={styles.totLabel}>
                {/* The exemption label is driven by the deal's CURRENT flag,
                    but the amount is the invoice's FROZEN tax_pct. Flip a deal
                    to exempt after issuing a taxable invoice and the two
                    disagree — the PDF certified an exemption while charging
                    $431.25 of tax on the same line. Only claim exemption when
                    the invoice actually carries no tax. */}
                {input.isTaxExempt && input.taxCents === 0
                  ? `Tax-exempt${input.taxExemptCertNumber ? ` · Cert #${input.taxExemptCertNumber}` : ""}`
                  : `Tax (${Number(input.taxPct).toFixed(3).replace(/\.?0+$/, "")}%)`}
              </Text>
              <Text>{fmt(input.taxCents)}</Text>
            </View>
            <View style={styles.grandLine}>
              <Text style={styles.bold}>Total</Text>
              <Text style={styles.bold}>{fmt(input.totalCents)}</Text>
            </View>
            {input.paidCents > 0 ? (
              <View style={styles.totLine}>
                <Text style={styles.totLabel}>Paid</Text>
                <Text>-{fmt(input.paidCents)}</Text>
              </View>
            ) : null}
            {/* Overpaid invoices read as a CREDIT, not a negative "balance due"
                ("Balance due -$100" would look like the GC owes a negative). */}
            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>{input.balanceCents < 0 ? "Credit balance" : "Balance due"}</Text>
              <Text style={styles.balanceVal}>{fmt(Math.abs(input.balanceCents))}</Text>
            </View>
          </View>
        </View>

        {/* Customer message */}
        {input.customerMessage ? (
          <View style={styles.msgBox} wrap={false}>
            <Text style={styles.label}>Message</Text>
            <Text>{input.customerMessage}</Text>
          </View>
        ) : null}

        {/* Remit-to */}
        <View style={styles.remitBox} wrap={false}>
          <Text style={[styles.label, { marginBottom: 3 }]}>Payment</Text>
          {input.paymentTerms ? <Text style={styles.bold}>Terms: {input.paymentTerms}</Text> : null}
          {remitLines(input.company).map((l, i) => (
            <Text key={i}>{l}</Text>
          ))}
        </View>

        <Text style={styles.footer} fixed>
          Thank you for your business. Questions on this invoice? Reply to this email or call the number above.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  return renderToBuffer(<InvoiceDoc {...input} />);
}
