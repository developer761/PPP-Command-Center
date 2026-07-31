import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";
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
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

export type CompanyContact = { name: string; phone?: string | null; website?: string | null };

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

function TransmittalDoc({ pkg, items, dealName, company, logo }: { pkg: PkgInput; items: ItemInput[]; dealName: string; company: CompanyContact; logo?: Buffer | null }) {
  const fromCompany = company.name;
  const included = items.filter((i) => i.included);
  const dateStr = fmtDate((pkg.sent_at ?? pkg.created_at).slice(0, 10));
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <LogoBlock company={company} logo={logo} />
        <View style={styles.row}>
          <View style={{ width: "60%" }}>
            <Text style={styles.label}>Transmitted to</Text>
            <Text style={styles.bold}>{pkg.to_company || "—"}</Text>
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

function WarrantyDoc({ pkg, dealName, company, logo }: { pkg: PkgInput; dealName: string; company: CompanyContact; logo?: Buffer | null }) {
  const fromCompany = company.name;
  const start = pkg.substantial_completion_date;
  const end = computeWarrantyEndDate(start, pkg.warranty_years);
  const dateStr = fmtDate((pkg.sent_at ?? pkg.created_at).slice(0, 10));
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <LogoBlock company={company} logo={logo} />
        <View style={styles.row}>
          <View style={{ width: "60%" }}>
            <Text style={styles.bold}>{pkg.to_company || "—"}</Text>
            {pkg.to_attention ? <Text>Attn: {pkg.to_attention}</Text> : null}
            {(pkg.to_address_lines ?? []).map((l, i) => <Text key={i}>{l}</Text>)}
          </View>
          <View style={{ width: "35%", textAlign: "right" }}>
            <Text>{dateStr}</Text>
          </View>
        </View>

        <Text style={styles.h1}>Warranty</Text>
        <Text style={styles.para}>Re: <Text style={styles.bold}>{pkg.re_subject || dealName}</Text></Text>

        <Text style={styles.para}>
          {fromCompany} warrants that all painting and coating work performed on the above-referenced project has been
          completed in a good and workmanlike manner, in accordance with the contract documents and manufacturer
          specifications.
        </Text>
        <Text style={styles.para}>
          This warranty covers defects in workmanship and materials for a period of{" "}
          <Text style={styles.bold}>{pkg.warranty_years} year{pkg.warranty_years === 1 ? "" : "s"}</Text> from the date
          of substantial completion, <Text style={styles.bold}>{fmtDate(start)}</Text>, and remains in effect through{" "}
          <Text style={styles.bold}>{fmtDate(end)}</Text>.
        </Text>
        <Text style={styles.para}>
          During the warranty period, {fromCompany} will, upon written notice, repair or re-coat any covered defect at no
          cost to the owner. This warranty excludes damage from causes beyond normal wear — including but not limited to
          structural movement, water intrusion, abuse, or alteration by others.
        </Text>

        <View style={styles.sig}>
          <Text style={styles.bold}>{fromCompany}</Text>
          <Text style={{ fontSize: 8, color: "#6b7280" }}>Authorized signature</Text>
        </View>

        <Text style={styles.footer}>{fromCompany} · Project Warranty</Text>
      </Page>
    </Document>
  );
}

export async function renderCloseoutTransmittalPdf(input: { pkg: PkgInput; items: ItemInput[]; dealName: string; company: CompanyContact; logo?: Buffer | null }): Promise<Buffer> {
  return renderToBuffer(<TransmittalDoc {...input} />);
}

export async function renderWarrantyLetterPdf(input: { pkg: PkgInput; dealName: string; company: CompanyContact; logo?: Buffer | null }): Promise<Buffer> {
  return renderToBuffer(<WarrantyDoc {...input} />);
}
