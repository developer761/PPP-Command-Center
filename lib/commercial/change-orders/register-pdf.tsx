import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { formatChangeOrderNumber } from "./constants";
import { formatCentsFull } from "@/lib/commercial/invoices/format";

/**
 * The CHANGE ORDERS register — every change order on a job, on one document.
 *
 * Stephanie, 2026-08-19, sending Brendan's format: *"the goal here is to be
 * able to generate a PDF that lists all change orders with the status as well
 * as have the option to send out a PDF with just one change order on it."*
 *
 * The single-CO document already existed (pdf.tsx) — that's the one that goes
 * out for signature. This is the other half: the running log a GC asks for when
 * they want to see where the contract actually stands.
 *
 * Laid out to the sample Brendan supplied: letterhead, a CHANGE ORDERS banner,
 * project block, one bordered card per change order with the status badged on
 * the right, then a summary that totals by status and reconciles the original
 * contract to the updated one.
 *
 * Two deliberate departures from that sample, both because it would otherwise
 * state something untrue:
 *
 *  1. PENDING change orders are totalled but explicitly NOT added to the
 *     updated contract. The sample's "Updated Contract Total" happens to equal
 *     original + APPROVED only, which is right — but nothing on the page says
 *     so, and a GC reading "Total Change Orders $61,435" directly above
 *     "Updated Contract Total" can reasonably read the pending money as
 *     committed. It isn't, until they approve it. The line says which it used.
 *
 *  2. A deduct (credit) change order prints as a negative rather than being
 *     bucketed as if it were added scope, so the totals still reconcile on a
 *     job that has one.
 *
 *  3. REJECTED change orders are the same trap as pending, and get the same
 *     sentence. "Total Change Orders" is the register's own total — every CO
 *     ever raised, which is what makes the list of cards reconcile with it —
 *     so on a job with a rejection it does not match the updated contract, and
 *     the note has to say why. Naming only the pending money left a job with a
 *     rejection and nothing pending printing an unexplained discrepancy.
 */

const NAVY = "#172B4D";
const styles = StyleSheet.create({
  page: {
    paddingTop: 54,
    paddingBottom: 64,
    paddingHorizontal: 54,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1f2937",
    lineHeight: 1.45,
  },
  logoImage: { height: 42, objectFit: "contain", alignSelf: "center", marginBottom: 2 },
  wordmark: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: 1, textAlign: "center", color: NAVY },
  contact: { fontSize: 7.5, textAlign: "center", color: "#9ca3af", marginTop: 3, letterSpacing: 0.3 },

  banner: { backgroundColor: NAVY, paddingVertical: 7, marginTop: 16, marginBottom: 16 },
  bannerText: {
    color: "#ffffff",
    fontFamily: "Helvetica-Bold",
    fontSize: 13,
    textAlign: "center",
    textTransform: "uppercase",
    letterSpacing: 1.5,
  },

  sectionHead: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: NAVY,
    marginBottom: 5,
    paddingBottom: 3,
    borderBottomWidth: 0.75,
    borderBottomColor: "#d1d5db",
  },
  metaRow: { flexDirection: "row", marginBottom: 2 },
  metaLabel: { width: 96, color: "#6b7280" },
  metaVal: { flex: 1 },

  card: { borderWidth: 0.75, borderColor: "#e5e7eb", borderRadius: 3, marginBottom: 7 },
  cardHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#f3f4f6",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  cardTitle: { fontFamily: "Helvetica-Bold", fontSize: 10.5, color: "#111827" },
  badge: { fontSize: 8, fontFamily: "Helvetica-Bold", textTransform: "capitalize" },
  cardBody: { paddingVertical: 5, paddingHorizontal: 8 },
  line: { flexDirection: "row", marginBottom: 1.5 },
  lineLabel: { width: 76, color: "#6b7280", fontSize: 9 },
  lineVal: { flex: 1, fontSize: 9.5 },
  costVal: { flex: 1, fontSize: 10, fontFamily: "Helvetica-Bold", color: "#111827" },

  sumRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3.5,
    borderBottomWidth: 0.5,
    borderBottomColor: "#f3f4f6",
  },
  sumLabelWrap: { flexDirection: "row", alignItems: "center" },
  swatch: { width: 6, height: 6, marginRight: 6 },
  sumLabel: { color: "#4b5563" },
  sumTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 6,
    marginTop: 3,
    borderTopWidth: 1.25,
    borderTopColor: "#111827",
  },
  bold: { fontFamily: "Helvetica-Bold" },
  muted: { color: "#6b7280" },
  note: { fontSize: 7.5, color: "#9ca3af", marginTop: 6, lineHeight: 1.4 },

  contFooter: { fontSize: 8, fontStyle: "italic", color: "#9ca3af", textAlign: "center", marginTop: 10 },
  footer: {
    position: "absolute",
    bottom: 30,
    left: 54,
    right: 54,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: "#9ca3af",
    borderTopWidth: 0.5,
    borderTopColor: "#e5e7eb",
    paddingTop: 6,
  },
});

const TONE: Record<string, string> = {
  approved: "#15803d",
  pending: "#6b7280",
  declined: "#b91c1c",
};

// Was a local copy with an identical body. Proven equivalent on every case
// tried — and the shared one additionally guards NaN, which the local one
// rendered as "$NaN" on a document that goes to a GC.
const money = formatCentsFull;


function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // ET, two-digit year — matches the sample ("03/04/26").
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

export type ChangeOrderRegisterRow = {
  coNumber: number;
  title: string;
  description: string | null;
  amountCents: number;
  status: string;
  raisedIso: string | null;
  decidedIso: string | null;
};

export type ChangeOrderRegisterInput = {
  /** Lay out on a sheet this many times taller than Letter so the document
   *  flows onto ONE page; the caller scales it back to Letter. Karan
   *  2026-08-26: "everything is supposed to have one page for the PDF."
   *  See lib/commercial/proposals/fit-one-page. */
  pageHeightScale?: number;

  projectName: string;
  jobNumber: string | null;
  address: string | null;
  clientName: string;
  documentNumber: string | null;
  rows: ChangeOrderRegisterRow[];
  originalContractCents: number | null;
  company: { name: string; phone?: string | null; website?: string | null };
  logo?: Buffer | null;
};

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}:</Text>
      <Text style={styles.metaVal}>{value}</Text>
    </View>
  );
}

function Line({ label, value, cost = false }: { label: string; value: string; cost?: boolean }) {
  return (
    <View style={styles.line}>
      <Text style={[styles.lineLabel, cost ? styles.bold : {}]}>{label}:</Text>
      <Text style={cost ? styles.costVal : styles.lineVal}>{value}</Text>
    </View>
  );
}

function SummaryRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.sumRow}>
      <View style={styles.sumLabelWrap}>
        {tone ? <View style={[styles.swatch, { backgroundColor: tone }]} /> : null}
        <Text style={styles.sumLabel}>{label}:</Text>
      </View>
      <Text>{value}</Text>
    </View>
  );
}

export type ChangeOrderRegisterSummary = {
  approvedTotal: number;
  pendingTotal: number;
  declinedTotal: number;
  /** Every CO ever raised — the sample's "Total Change Orders". */
  allTotal: number;
  /** Original + APPROVED only. Null when no contract figure is on file. */
  updatedContract: number | null;
  /**
   * The sentence reconciling the two, or null when they already agree.
   *
   * Pure, and tested, because this sentence IS the fix: "Total Change Orders"
   * is the register's own total, so on any job with pending OR rejected scope
   * it does not equal the contract movement directly beneath it, and a GC's AP
   * department is left to guess. The first cut named only the pending money —
   * so a job with a rejection and nothing pending printed the discrepancy with
   * nothing to explain it.
   */
  note: string | null;
};

/** The summary block's arithmetic and its reconciling sentence. */
export function summarizeChangeOrderRegister(
  rows: ChangeOrderRegisterRow[],
  originalContractCents: number | null,
  money: (cents: number) => string
): ChangeOrderRegisterSummary {
  const sum = (status: ChangeOrderRegisterRow["status"]) =>
    rows.filter((r) => r.status === status).reduce((n, r) => n + r.amountCents, 0);
  const approvedTotal = sum("approved");
  const pendingTotal = sum("pending");
  const declinedTotal = sum("declined");
  const allTotal = approvedTotal + pendingTotal + declinedTotal;
  const updatedContract =
    originalContractCents != null ? originalContractCents + approvedTotal : null;

  let note: string | null = null;
  if (updatedContract != null && (pendingTotal !== 0 || declinedTotal !== 0)) {
    note =
      "Updated Contract Total includes APPROVED change orders only." +
      (pendingTotal !== 0
        ? ` The ${money(pendingTotal)} pending above is not part of the contract until approved.`
        : "") +
      (declinedTotal !== 0
        ? ` The ${money(declinedTotal)} rejected is listed for the record only and is not part of the contract.`
        : "");
  }
  return { approvedTotal, pendingTotal, declinedTotal, allTotal, updatedContract, note };
}

function ChangeOrderRegisterDocument(input: ChangeOrderRegisterInput) {
  const { approvedTotal, pendingTotal, declinedTotal, allTotal, updatedContract, note } =
    summarizeChangeOrderRegister(input.rows, input.originalContractCents ?? null, money);

  return (
    <Document title={`Change Orders — ${input.projectName}`}>
      <Page size={(input.pageHeightScale ?? 1) === 1 ? "LETTER" : { width: 612, height: 792 * (input.pageHeightScale ?? 1) }} style={styles.page}>
        {input.logo ? (
          <Image src={input.logo} style={styles.logoImage} />
        ) : (
          <Text style={styles.wordmark}>{input.company.name}</Text>
        )}
        <Text style={styles.contact}>
          {[input.company.name, input.company.phone, input.company.website].filter(Boolean).join("  |  ")}
        </Text>

        <View style={styles.banner}>
          <Text style={styles.bannerText}>Change Orders</Text>
        </View>

        <Text style={styles.sectionHead}>Project Information</Text>
        <View style={{ marginBottom: 14 }}>
          <Meta label="Project" value={input.projectName} />
          {input.jobNumber ? <Meta label="Job #" value={input.jobNumber} /> : null}
          {input.address ? <Meta label="Address" value={input.address} /> : null}
          <Meta label="Client" value={input.clientName} />
          {input.documentNumber ? <Meta label="Document #" value={input.documentNumber} /> : null}
        </View>

        {input.rows.length === 0 ? (
          <Text style={styles.muted}>No change orders have been raised on this project.</Text>
        ) : (
          input.rows.map((r) => (
            <View key={r.coNumber} style={styles.card} wrap={false}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>Change Order #{r.coNumber}</Text>
                <Text style={[styles.badge, { color: TONE[r.status] ?? "#6b7280" }]}>{r.status}</Text>
              </View>
              <View style={styles.cardBody}>
                <Line label="Date" value={fmtDate(r.raisedIso)} />
                {/* Only for a CO that actually got an answer — printing
                    "Approved On: —" on a pending one reads as missing data. */}
                {r.status !== "pending" && r.decidedIso ? (
                  <Line
                    label={r.status === "approved" ? "Approved On" : "Declined On"}
                    value={fmtDate(r.decidedIso)}
                  />
                ) : null}
                <Line label="Description" value={r.title} />
                {r.description?.trim() ? <Line label="Scope" value={r.description.trim()} /> : null}
                <Line label="Cost" value={money(r.amountCents)} cost />
              </View>
            </View>
          ))
        )}

        {input.rows.length > 0 ? (
          <View style={{ marginTop: 14 }} wrap={false}>
            <Text style={styles.sectionHead}>Change Orders Summary</Text>
            <SummaryRow label="Approved Change Orders Total" value={money(approvedTotal)} tone={TONE.approved} />
            <SummaryRow label="Pending Change Orders Total" value={money(pendingTotal)} tone={TONE.pending} />
            <SummaryRow label="Rejected Change Orders Total" value={money(declinedTotal)} tone={TONE.declined} />
            <View style={styles.sumTotal}>
              <Text style={styles.bold}>Total Change Orders:</Text>
              <Text style={styles.bold}>{money(allTotal)}</Text>
            </View>

            {input.originalContractCents != null ? (
              <View style={{ marginTop: 10 }}>
                <View style={styles.sumRow}>
                  <Text style={styles.muted}>Original Contract Total:</Text>
                  <Text style={styles.muted}>{money(input.originalContractCents)}</Text>
                </View>
                <View style={styles.sumTotal}>
                  <Text style={styles.bold}>Updated Contract Total:</Text>
                  <Text style={styles.bold}>{money(updatedContract ?? 0)}</Text>
                </View>
                {/* Without this, "Total Change Orders" sitting directly above
                    "Updated Contract Total" invites a GC to read money that
                    isn't in the contract as though it were.
                    
                    It has to cover REJECTED as well as pending. "Total Change
                    Orders" is the register's own total — every CO ever raised,
                    which is what makes the list reconcile — so a job with a
                    rejected CO shows a change-order total the updated contract
                    doesn't match, and the GC's AP department cannot tell why.
                    The first cut named only the pending money, so a job with a
                    rejection and nothing pending printed the discrepancy with
                    no explanation at all. */}
                {note ? <Text style={styles.note}>{note}</Text> : null}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text>{input.documentNumber ?? input.projectName}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderChangeOrderRegisterPdf(
  input: ChangeOrderRegisterInput
): Promise<Buffer> {
  return renderToBuffer(<ChangeOrderRegisterDocument {...input} />);
}

/** Shared with the route so the filename and the on-page Document # agree. */
export function changeOrderRegisterDocNumber(projectNumber: string | null): string | null {
  return projectNumber ? `CO-${projectNumber}` : null;
}

export { formatChangeOrderNumber };
