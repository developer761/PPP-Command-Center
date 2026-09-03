import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";
import { etDateOf } from "@/lib/date-et";
import {
  CLOSEOUT_ITEM_KIND_LABEL,
  CLOSEOUT_ITEM_STATUS_LABEL,
  CLOSEOUT_TRANSMITTED_AS_LABEL,
  computeWarrantyEndDate,
  type CloseoutTransmittedAs,
  type CloseoutItemKind,
  type CloseoutItemStatus,
} from "./constants";

Font.registerHyphenationCallback((word) => [word]);

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 54, paddingHorizontal: 54, fontSize: 10, fontFamily: "Helvetica", color: "#1f2937", lineHeight: 1.4 },
  wordmark: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: 1, textAlign: "center", color: "#172B4D" },
  logoImage: { height: 42, objectFit: "contain", alignSelf: "center", marginBottom: 2 },
  sigImage: { height: 40, objectFit: "contain", marginBottom: 2, alignSelf: "flex-start" },
  tagline: { fontSize: 8, textAlign: "center", color: "#6b7280", marginTop: 3, fontFamily: "Helvetica-Oblique" },
  contact: { fontSize: 7.5, textAlign: "center", color: "#9ca3af", marginTop: 3, letterSpacing: 0.3 },
  rule: { borderBottomWidth: 2, borderBottomColor: "#EE662E", marginTop: 12, marginBottom: 18 },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  label: { fontSize: 7.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  bold: { fontFamily: "Helvetica-Bold" },
  block: { marginBottom: 12 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#111827", paddingBottom: 4, marginBottom: 4 },
  th: { fontSize: 8, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.4, color: "#374151" },
  tr: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  cItem: { width: "68%" },
  cStatus: { width: "32%", textAlign: "right" },
  footer: { position: "absolute", bottom: 30, left: 54, right: 54, fontSize: 7.5, color: "#9ca3af", textAlign: "center", borderTopWidth: 0.5, borderTopColor: "#e5e7eb", paddingTop: 6 },
  para: { marginBottom: 10 },
  sig: { marginTop: 40, borderTopWidth: 1, borderTopColor: "#111827", width: 220, paddingTop: 4 },
  // Form of Warranty — the signature block is a labelled list on Tomco's form
  // ("By / Title / Company / Address / Telephone"), not a rule with a name
  // under it.
  fwLine: { flexDirection: "row", marginBottom: 3 },
  fwLabel: { width: 74, fontFamily: "Helvetica-Bold" },
  fwNote: { fontSize: 8, color: "#6b7280", fontFamily: "Helvetica-Oblique", marginTop: -6, marginBottom: 10 },
  fwRule: { borderBottomWidth: 1, borderBottomColor: "#111827", width: 220, height: 22 },
});

type PkgInput = {
  status: string;
  to_company: string | null;
  to_attention: string | null;
  to_address_lines: string[] | null;
  re_subject: string | null;
  transmitted_as: CloseoutTransmittedAs | null;
  remarks: string | null;
  substantial_completion_date: string | null;
  warranty_years: number;
  sent_at: string | null;
  created_at: string;
};
type ItemInput = { kind: CloseoutItemKind; label: string | null; included: boolean; item_status: CloseoutItemStatus };

function fmtDate(ymd: string | null): string {
  if (!ymd) return "—";
  // Through etDateOf FIRST. These columns are TIMESTAMPTZ, and slicing the raw
  // ISO string took the UTC calendar day — so a document produced after ~8pm
  // ET was stamped TOMORROW, and disagreed with the same date on screen.
  // etDateOf returns a bare YYYY-MM-DD untouched (a DATE column has no zone to
  // convert), so this is safe for both kinds of column.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(etDateOf(ymd) ?? "");
  if (!m) return ymd;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

export type CompanyContact = {
  name: string;
  phone?: string | null;
  website?: string | null;
  /** The postal block Tomco's Form of Warranty signs off with — "Company /
   *  Address / Telephone". Optional so the transmittal, which doesn't print
   *  it, can keep passing what it always did. */
  legal_name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  /** Who signs, and as what. Tomco's Form of Warranty names the signer
   *  ("Brendan Dwyer, VP"); "Authorized signature" over a company name does
   *  not say who stood behind a twelve-month guarantee. Null keeps the old
   *  line rather than printing an empty Title, which reads as a mistake. */
  signature_name?: string | null;
  signature_title?: string | null;
};

function LogoBlock({ company, logo }: { company: CompanyContact; logo?: Buffer | null }) {
  const website = (company.website ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const contact = [company.phone, website].filter(Boolean).join("   ·   ");
  return (
    <View>
      {logo ? (
        <Image src={logo} style={styles.logoImage} />
      ) : (
        <Text style={styles.wordmark}>{company.name}</Text>
      )}
      {contact ? <Text style={styles.contact}>{contact}</Text> : null}
      <View style={styles.rule} />
    </View>
  );
}

function TransmittalDoc({ pkg, items, dealName, accountName, company, logo, pageHeightScale = 1 }: { pkg: PkgInput; items: ItemInput[]; dealName: string; accountName?: string | null; company: CompanyContact; logo?: Buffer | null; pageHeightScale?: number }) {
  const fromCompany = company.name;
  const included = items.filter((i) => i.included);
  const dateStr = fmtDate((pkg.sent_at ?? pkg.created_at).slice(0, 10));
  return (
    <Document>
      <Page size={pageHeightScale === 1 ? "LETTER" : { width: 612, height: 792 * pageHeightScale }} style={styles.page}>
        <LogoBlock company={company} logo={logo} />
        <View style={styles.row}>
          <View style={{ width: "60%" }}>
            <Text style={styles.label}>Transmitted to</Text>
            <Text style={styles.bold}>{pkg.to_company || accountName || "—"}</Text>
            {pkg.to_attention ? <Text>Attn: {pkg.to_attention}</Text> : null}
            {(pkg.to_address_lines ?? []).map((l, i) => <Text key={i}>{l}</Text>)}
          </View>
          <View style={{ width: "35%", textAlign: "right" }}>
            <Text style={styles.label}>Date</Text>
            <Text style={styles.bold}>{dateStr}</Text>
            <Text style={[styles.label, { marginTop: 8 }]}>Transmitted as</Text>
            <Text>{pkg.transmitted_as ? CLOSEOUT_TRANSMITTED_AS_LABEL[pkg.transmitted_as] : "For your records"}</Text>
          </View>
        </View>

        {/* "Close-Out" hyphenated ONLY here and in the default subject line:
            this is the title of Tomco's real transmittal document, verified
            against their samples. The app chrome says "Closeout" everywhere.
            Don't normalize this one to match it. */}
        <Text style={styles.h1}>Letter of Transmittal — Project Close-Out</Text>
        <View style={styles.block}>
          <Text style={styles.label}>Re</Text>
          <Text style={styles.bold}>{pkg.re_subject || `Project Close-Out — ${dealName}`}</Text>
        </View>

        <Text style={{ marginBottom: 8 }}>We are transmitting the following close-out documents for the referenced project:</Text>
        <View style={styles.tableHead}>
          <Text style={[styles.th, styles.cItem]}>Item</Text>
          <Text style={[styles.th, styles.cStatus]}>Status</Text>
        </View>
        {included.map((it, i) => (
          <View key={i} style={styles.tr}>
            <Text style={styles.cItem}>{it.label || CLOSEOUT_ITEM_KIND_LABEL[it.kind]}</Text>
            <Text style={styles.cStatus}>{CLOSEOUT_ITEM_STATUS_LABEL[it.item_status]}</Text>
          </View>
        ))}
        {included.length === 0 ? <Text style={{ color: "#9ca3af", marginTop: 4 }}>(no items included)</Text> : null}

        <View style={{ marginTop: 16 }}>
          <Text style={styles.label}>Warranty</Text>
          <Text>
            Substantial completion {fmtDate(pkg.substantial_completion_date)} · {pkg.warranty_years}-year warranty through{" "}
            <Text style={styles.bold}>{fmtDate(computeWarrantyEndDate(pkg.substantial_completion_date, pkg.warranty_years))}</Text>.
          </Text>
        </View>

        {pkg.remarks ? (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.label}>Remarks</Text>
            <Text>{pkg.remarks}</Text>
          </View>
        ) : null}

        <Text style={styles.footer}>{fromCompany} · Project Close-Out Transmittal</Text>
      </Page>
    </Document>
  );
}

/**
 * The Tomco FORM OF WARRANTY — Katie's captured `Warranty Letter - Tomco.docx`,
 * which is the document Brendan actually signs and GCs actually accept.
 *
 * This used to be a paraphrase written here: "Warranty", a good-and-workmanlike
 * paragraph, and a carve-out for structural movement and water intrusion. It
 * read well and it was the wrong document. A close-out warranty is a form the
 * specification names; a GC's close-out clerk checks that the undertaking and
 * the term are the ones the contract called for, and a rewritten one invites
 * exactly the query the package exists to avoid.
 *
 * Two things carried over from the paraphrase because they are ours, not the
 * form's: the letterhead, and the tap-to-sign signature image.
 *
 * NOTE the term is stated in MONTHS. Tomco's form says "a period of 12 months
 * from the date hereof", and `warranty_years` of 1 is that same twelve months —
 * saying it the form's way costs nothing and matches what the GC is looking for.
 */
function WarrantyDoc({ pkg, dealName, accountName, company, logo, signature, pageHeightScale = 1 }: { pkg: PkgInput; dealName: string; accountName?: string | null; company: CompanyContact; logo?: Buffer | null; signature?: Buffer | null; pageHeightScale?: number }) {
  const fromCompany = company.legal_name || company.name;
  const start = pkg.substantial_completion_date;
  const end = computeWarrantyEndDate(start, pkg.warranty_years);
  const dateStr = fmtDate((pkg.sent_at ?? pkg.created_at).slice(0, 10));
  const months = Math.round(pkg.warranty_years * 12);
  const contractor = pkg.to_company || accountName || "—";
  const job = pkg.re_subject || dealName;
  const cityLine = [[company.city, company.state].filter(Boolean).join(", "), company.zip]
    .filter(Boolean)
    .join(" ");
  const addressLines = [company.address_line1, company.address_line2, cityLine].filter(
    (l): l is string => !!l && l.trim().length > 0
  );

  return (
    <Document>
      <Page size={pageHeightScale === 1 ? "LETTER" : { width: 612, height: 792 * pageHeightScale }} style={styles.page}>
        <LogoBlock company={company} logo={logo} />
        <View style={styles.row}>
          <View style={{ width: "60%" }}>
            <Text style={styles.bold}>{contractor}</Text>
            {pkg.to_attention ? <Text>Attn: {pkg.to_attention}</Text> : null}
            {(pkg.to_address_lines ?? []).map((l, i) => <Text key={i}>{l}</Text>)}
          </View>
          <View style={{ width: "35%", textAlign: "right" }}>
            <Text>{dateStr}</Text>
          </View>
        </View>

        <Text style={styles.h1}>Form of Warranty</Text>

        {/* The form states when the clock starts, and says what the default is
            when nobody has written a date on it. Printing a blank rule rather
            than a guess is what the paper form does. */}
        <Text style={styles.para}>
          <Text style={styles.bold}>The warranty period begins: </Text>
          {start ? fmtDate(start) : "____________________"}
          {start && end ? <Text> (through {fmtDate(end)})</Text> : null}
        </Text>
        <Text style={styles.fwNote}>
          Shall be the Date of Owner Acceptance or issuance of the certificate of occupancy,
          unless otherwise noted in the specifications.
        </Text>

        <Text style={styles.para}>
          The undersigned, having heretofore entered into a contract with{" "}
          <Text style={styles.bold}>{contractor}</Text> for:{" "}
          <Text style={styles.bold}>{job}</Text>, according to certain plans and
          specifications, do hereby guarantee that all labor and materials furnished and work
          performed thereunder are in conformity with such plans and specifications and are free
          from imperfect workmanship.
        </Text>
        <Text style={styles.para}>
          We agree to repair and/or replace at our own expense all of the work covered under the
          contract and change orders which may prove to be defective for a period of{" "}
          <Text style={styles.bold}>{months} months</Text> from the date hereof, or for such period
          as may be specifically called for in the contract or specifications for individual work
          items.
        </Text>
        <Text style={styles.para}>
          Furthermore, we agree to repair and/or replace at our sole cost any work which we may
          affect or disturb in making the repairs described above.
        </Text>

        <View style={{ marginTop: 28 }}>
          {signature ? (
            <View style={styles.fwLine}>
              <Text style={styles.fwLabel}>By:</Text>
              <Image src={signature} style={styles.sigImage} />
            </View>
          ) : (
            <View style={styles.fwLine}>
              <Text style={styles.fwLabel}>By:</Text>
              <View style={styles.fwRule} />
            </View>
          )}
          {company.signature_name ? (
            <View style={styles.fwLine}>
              <Text style={styles.fwLabel}>Name:</Text>
              <Text>{company.signature_name}</Text>
            </View>
          ) : null}
          {company.signature_title ? (
            <View style={styles.fwLine}>
              <Text style={styles.fwLabel}>Title:</Text>
              <Text>{company.signature_title}</Text>
            </View>
          ) : null}
          <View style={styles.fwLine}>
            <Text style={styles.fwLabel}>Company:</Text>
            <Text>{fromCompany}</Text>
          </View>
          {addressLines.length > 0 ? (
            <View style={styles.fwLine}>
              <Text style={styles.fwLabel}>Address:</Text>
              <View>
                {addressLines.map((l, i) => <Text key={i}>{l}</Text>)}
              </View>
            </View>
          ) : null}
          {company.phone ? (
            <View style={styles.fwLine}>
              <Text style={styles.fwLabel}>Telephone:</Text>
              <Text>{company.phone}</Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.footer}>{fromCompany} · Form of Warranty</Text>
      </Page>
    </Document>
  );
}

export async function renderCloseoutTransmittalPdf(input: { pkg: PkgInput; items: ItemInput[]; dealName: string; accountName?: string | null; company: CompanyContact; logo?: Buffer | null; pageHeightScale?: number }): Promise<Buffer> {
  return renderToBuffer(<TransmittalDoc {...input} />);
}

export async function renderWarrantyLetterPdf(input: { pkg: PkgInput; dealName: string; accountName?: string | null; company: CompanyContact; logo?: Buffer | null; signature?: Buffer | null; pageHeightScale?: number }): Promise<Buffer> {
  return renderToBuffer(<WarrantyDoc {...input} />);
}
