import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";
import { PDFDocument } from "pdf-lib";
import { transliterateToWinAnsi } from "@/lib/commercial/proposals/pdf";
import { stampPageNumbers } from "@/lib/commercial/pdf/stamp-page-numbers";
import { formatAuditTimestamp } from "./constants";

Font.registerHyphenationCallback((word) => [word]);

/**
 * The two documents a signature produces.
 *
 *   Signature page — appended to the proposal snapshot the GC signed, making
 *     the signed contract. The proposal pages are carried over byte-for-byte
 *     (pdf-lib copy, never a re-render), so the contract is provably the same
 *     document the GC was shown.
 *
 *   Audit trail — the certificate, laid out after the S-Docs trail PPP already
 *     files for residential contracts: the signed document's SHA-256, who
 *     requested it, where it was signed, a signer table and every event. Filed
 *     under Reports → Signatures.
 *
 * Both render in the standard-14 Helvetica like every other Commercial PDF, so
 * all text goes through `pdfText` — Helvetica is WinAnsi-encoded and prints any
 * other code point as a stray glyph. A signer's name is typed by a stranger on
 * a public page and can be anything.
 */

/** WinAnsi-safe text: the proposal's transliterations, then anything still
 *  outside WinAnsi becomes "?" rather than a wrong glyph. */
export function pdfText(s: string | null | undefined): string {
  if (!s) return "";
  const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  return Array.from(transliterateToWinAnsi(s))
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c === 0x0a) return ch;
      if (c >= 0x20 && c <= 0x7e) return ch;
      if (c >= 0xa0 && c <= 0xff) return ch;
      return WINANSI_EXTRA.includes(ch) ? ch : "?";
    })
    .join("");
}

const NAVY = "#172B4D";
const ORANGE = "#EE662E";
const GREY_BAR = "#6b7280";
const BLUE_HEAD = "#2BAAE1";

const a = StyleSheet.create({
  page: { paddingTop: 30, paddingBottom: 44, paddingHorizontal: 40, fontSize: 8.5, fontFamily: "Helvetica", color: "#1f2937", lineHeight: 1.3 },
  logo: { height: 30, objectFit: "contain", alignSelf: "center" },
  rule: { borderBottomWidth: 1.5, borderBottomColor: ORANGE, marginTop: 6, marginBottom: 8 },
  title: { fontSize: 15, textAlign: "center", letterSpacing: 4, color: NAVY, marginBottom: 8 },
  bar: { backgroundColor: GREY_BAR, color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 9, textAlign: "center", paddingVertical: 2.5 },
  box: { borderWidth: 0.75, borderColor: "#111827", marginBottom: 7 },
  row: { paddingHorizontal: 4, paddingVertical: 2, borderTopWidth: 0.5, borderTopColor: "#111827" },
  th: { backgroundColor: BLUE_HEAD, color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 7.5, paddingHorizontal: 3, paddingVertical: 2, textAlign: "center", borderRightWidth: 0.5, borderRightColor: "#111827" },
  td: { fontSize: 7.5, paddingHorizontal: 3, paddingVertical: 2, borderRightWidth: 0.5, borderRightColor: "#111827" },
  tr: { flexDirection: "row", borderTopWidth: 0.5, borderTopColor: "#111827" },
  footer: { position: "absolute", bottom: 20, left: 40, right: 40, fontSize: 6.5, color: "#9ca3af", textAlign: "center" },
});

const s = StyleSheet.create({
  page: { paddingTop: 46, paddingBottom: 60, paddingHorizontal: 48, fontSize: 9.5, fontFamily: "Helvetica", color: "#1f2937", lineHeight: 1.4 },
  wordmark: { fontSize: 17, fontFamily: "Helvetica-Bold", letterSpacing: 1, textAlign: "center", color: NAVY },
  logo: { height: 40, objectFit: "contain", alignSelf: "center", marginBottom: 2 },
  contact: { fontSize: 7.5, textAlign: "center", color: "#6b7280", marginTop: 3 },
  rule: { borderBottomWidth: 2, borderBottomColor: ORANGE, marginTop: 10, marginBottom: 16 },
  title: { fontSize: 20, textAlign: "center", letterSpacing: 5, color: NAVY, marginBottom: 16 },
  h1: { fontSize: 14, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1.4, color: NAVY, marginBottom: 12 },
  bar: { backgroundColor: GREY_BAR, color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 10.5, textAlign: "center", paddingVertical: 4 },
  box: { borderWidth: 1, borderColor: "#111827", marginBottom: 14 },
  boxRow: { paddingHorizontal: 5, paddingVertical: 3, borderTopWidth: 0.75, borderTopColor: "#111827" },
  mono: { fontFamily: "Courier", fontSize: 9 },
  th: { backgroundColor: BLUE_HEAD, color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 8.5, paddingHorizontal: 4, paddingVertical: 3, textAlign: "center", borderRightWidth: 0.75, borderRightColor: "#111827" },
  td: { fontSize: 8.5, paddingHorizontal: 4, paddingVertical: 3, borderRightWidth: 0.75, borderRightColor: "#111827" },
  tr: { flexDirection: "row", borderTopWidth: 0.75, borderTopColor: "#111827" },
  label: { fontSize: 7.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 1 },
  metaVal: { fontFamily: "Helvetica-Bold", marginBottom: 6 },
  para: { marginBottom: 8 },
  signWrap: { flexDirection: "row", justifyContent: "space-between", marginTop: 26 },
  signCol: { width: "46%" },
  sigArea: { height: 58, justifyContent: "flex-end" },
  sigImage: { height: 52, objectFit: "contain", alignSelf: "flex-start" },
  sigStamp: { fontSize: 6.5, color: "#6b7280", marginTop: 2 },
  sigLine: { borderTopWidth: 1, borderTopColor: "#111827", marginTop: 3, paddingTop: 3 },
  pending: { fontSize: 9, color: "#9ca3af", fontFamily: "Helvetica-Oblique" },
  footer: { position: "absolute", bottom: 26, left: 48, right: 48, fontSize: 7, color: "#9ca3af", textAlign: "center", borderTopWidth: 0.5, borderTopColor: "#e5e7eb", paddingTop: 5 },
});

export type EsignCompany = {
  name: string;
  address_lines: string[];
  phone?: string | null;
  website?: string | null;
};

function Letterhead({ company, logo }: { company: EsignCompany; logo?: Buffer | null }) {
  const website = (company.website ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const contact = [...company.address_lines, company.phone, website].filter(Boolean).join("   ·   ");
  return (
    <View>
      {logo ? <Image src={logo} style={s.logo} /> : <Text style={s.wordmark}>{pdfText(company.name)}</Text>}
      {contact ? <Text style={s.contact}>{pdfText(contact)}</Text> : null}
      <View style={s.rule} />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature page
// ─────────────────────────────────────────────────────────────────────────────

export type SignaturePageInput = {
  company: EsignCompany;
  logo?: Buffer | null;
  requestId: string;
  proposalLabel: string;
  proposalNumber: string | null;
  projectName: string | null;
  gcCompany: string | null;
  proposalDate: string | null;
  documentSha256: string;
  customer: {
    name: string;
    title: string | null;
    company: string | null;
    email: string;
    signedAt: string;
    signature: Buffer;
  };
  /** Null until Tomco countersigns — the page then shows the line as pending. */
  contractor: {
    name: string;
    title: string | null;
    signedAt: string;
    signature: Buffer;
    /** The login that pressed Countersign — the stored signature is the
     *  company signer's, so the page says who applied it. */
    appliedBy?: string | null;
  } | null;
};

function SignatureBlock(props: {
  heading: string;
  image: Buffer | null;
  stamp: string | null;
  name: string | null;
  sub: string | null;
  date: string | null;
}) {
  return (
    <View style={s.signCol}>
      <View style={s.sigArea}>
        {props.image ? <Image src={props.image} style={s.sigImage} /> : <Text style={s.pending}>Awaiting signature</Text>}
      </View>
      {props.stamp ? <Text style={s.sigStamp}>{pdfText(props.stamp)}</Text> : null}
      <View style={s.sigLine}>
        <Text style={{ fontFamily: "Helvetica-Bold" }}>{props.heading}</Text>
        <Text>{pdfText(props.name) || " "}</Text>
        <Text style={{ color: "#4b5563" }}>{pdfText(props.sub) || " "}</Text>
      </View>
      <View style={[s.sigLine, { marginTop: 14 }]}>
        <Text style={{ fontFamily: "Helvetica-Bold" }}>Date signed</Text>
        <Text>{props.date ?? " "}</Text>
      </View>
    </View>
  );
}

function etDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

function stampLine(name: string, iso: string): string {
  const ts = formatAuditTimestamp(iso).replace(" America/New_York", " ET");
  return `Signed electronically by ${name} on ${ts}`;
}

function SignaturePageDoc(input: SignaturePageInput) {
  const c = input.customer;
  const k = input.contractor;
  const onBehalf = c.company?.trim() || input.gcCompany?.trim() || "the customer";
  return (
    <Document title={pdfText(`${input.proposalLabel} - Signatures`)}>
      <Page size="LETTER" style={s.page}>
        <Letterhead company={input.company} logo={input.logo} />
        <Text style={s.h1}>Proposal Acceptance</Text>

        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <View style={{ width: "56%" }}>
            <Text style={s.label}>Project</Text>
            <Text style={s.metaVal}>{pdfText(input.projectName) || "—"}</Text>
            <Text style={s.label}>General contractor</Text>
            <Text style={s.metaVal}>{pdfText(input.gcCompany) || "—"}</Text>
          </View>
          <View style={{ width: "40%" }}>
            <Text style={s.label}>Document</Text>
            <Text style={s.metaVal}>
              {pdfText([input.proposalLabel, input.proposalNumber ? `No. ${input.proposalNumber}` : null].filter(Boolean).join(" · "))}
            </Text>
            <Text style={s.label}>Proposal date</Text>
            <Text style={s.metaVal}>{pdfText(input.proposalDate) || "—"}</Text>
          </View>
        </View>

        <Text style={s.label}>Document fingerprint (SHA-256 of the proposal as sent)</Text>
        <Text style={[s.mono, { marginBottom: 14 }]}>{input.documentSha256}</Text>

        <Text style={s.para}>
          {pdfText(
            `The undersigned has reviewed the proposal identified above, which precedes this page, and accepts its scope of work, pricing, inclusions, exclusions and terms on behalf of ${onBehalf}. The undersigned represents that they are authorized to enter into this agreement for ${onBehalf}.`
          )}
        </Text>
        <Text style={s.para}>
          {pdfText(
            `Both parties agreed to conduct this transaction electronically. Each electronic signature below has the same force and effect as a handwritten signature. The full record of this signature, including timestamps and the devices used, is kept in the accompanying audit trail.`
          )}
        </Text>

        <View style={s.signWrap}>
          <SignatureBlock
            heading="Customer signature"
            image={c.signature}
            stamp={stampLine(c.name, c.signedAt)}
            name={c.name}
            sub={[c.title, c.company].filter(Boolean).join(", ") || c.email}
            date={etDate(c.signedAt)}
          />
          <SignatureBlock
            heading={`${input.company.name} representative`}
            image={k?.signature ?? null}
            stamp={k ? `${stampLine(k.name, k.signedAt)}${k.appliedBy ? ` · applied by ${k.appliedBy}` : ""}` : null}
            name={k?.name ?? null}
            sub={k ? [k.title, input.company.name].filter(Boolean).join(", ") : null}
            date={k ? etDate(k.signedAt) : null}
          />
        </View>

        <Text style={s.footer} fixed>
          {pdfText(`Electronically signed through ${input.company.name} · Signature request ${input.requestId}`)}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderSignaturePagePdf(input: SignaturePageInput): Promise<Buffer> {
  return renderToBuffer(<SignaturePageDoc {...input} />);
}

/**
 * The signed contract: every page of the proposal snapshot, then the signature
 * page. Pages are COPIED, so the proposal half is the same content the GC was
 * shown — not a fresh render that could have picked up an edit.
 */
export async function assembleSignedDocument(snapshot: Buffer, signaturePage: Buffer): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const src of [snapshot, signaturePage]) {
    const doc = await PDFDocument.load(new Uint8Array(src), { ignoreEncryption: true });
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit trail certificate
// ─────────────────────────────────────────────────────────────────────────────

export type AuditTrailInput = {
  company: EsignCompany;
  logo?: Buffer | null;
  requestId: string;
  documentTitle: string;
  statusLabel: string;
  documentSha256: string;
  signedSha256: string | null;
  requestedBy: string;
  createdFrom: string;
  signedAt: string;
  signers: Array<{
    name: string;
    email: string;
    profile: string;
    position: string;
    ip: string | null;
    signedAt: string | null;
  }>;
  events: Array<{ at: string; type: string; details: string }>;
  generatedAt: string;
};

const SIGNER_COLS = [
  { key: "name", label: "Signer Name", width: "15%" },
  { key: "email", label: "Signer Email", width: "25%" },
  { key: "profile", label: "Signer Profile", width: "15%" },
  { key: "position", label: "Signer Position", width: "10%" },
  { key: "ip", label: "Signer IP", width: "14%" },
  { key: "signedAt", label: "Signed Date & Time", width: "21%" },
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={a.box} wrap={false}>
      <Text style={a.bar}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ first, children }: { first?: boolean; children: React.ReactNode }) {
  return <Text style={[a.row, first ? { borderTopWidth: 0 } : {}]}>{children}</Text>;
}

/**
 * Compact on purpose: a normal signing (~10 events, long browser strings) must
 * fit ONE page — it is emailed to the customer with the signed copy. A trail
 * with many more events flows onto further pages rather than shrinking to
 * unreadable; this is a legal record, so every event prints in full.
 */
function AuditTrailDoc(input: AuditTrailInput) {
  const website = (input.company.website ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const contact = [...input.company.address_lines, input.company.phone, website].filter(Boolean).join("   ·   ");
  const mono = { fontFamily: "Courier", fontSize: 7.5 };
  return (
    <Document title={pdfText(`${input.documentTitle} - Audit Trail`)}>
      <Page size="LETTER" style={a.page}>
        <View>
          {input.logo ? <Image src={input.logo} style={a.logo} /> : <Text style={[s.wordmark, { fontSize: 14 }]}>{pdfText(input.company.name)}</Text>}
          {contact ? <Text style={[s.contact, { fontSize: 6.5, marginTop: 2 }]}>{pdfText(contact)}</Text> : null}
          <View style={a.rule} />
        </View>
        <Text style={a.title}>AUDIT TRAIL</Text>

        <Section title="Document">
          <Row first>{pdfText(`${input.documentTitle}  ·  Status: ${input.statusLabel}  ·  Request ${input.requestId}`)}</Row>
        </Section>

        <Section title="Unique ID (SHA-256 Hash of Signed Document)">
          {input.signedSha256 ? (
            <Row first><Text style={mono}>{input.signedSha256}</Text></Row>
          ) : (
            <Row first><Text style={{ color: "#6b7280" }}>{pdfText(`Issued when ${input.company.name} countersigns.`)}</Text></Row>
          )}
          <Row>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>Proposal as sent: </Text>
            <Text style={mono}>{input.documentSha256}</Text>
          </Row>
        </Section>

        <Section title="Signature Requested By">
          <Row first>{pdfText(input.requestedBy)}</Row>
        </Section>

        <Section title="Domains Where E-Signature Was Used">
          <Row first>{pdfText(`E-Signature request created and sent from the following domain: ${input.createdFrom}`)}</Row>
          <Row>{pdfText(`E-Signature request signed at the following domain: ${input.signedAt}`)}</Row>
        </Section>

        <View style={a.box} wrap={false}>
          <Text style={a.bar}>Signer Data</Text>
          <View style={[a.tr, { borderTopWidth: 0 }]}>
            {SIGNER_COLS.map((col, i) => (
              <Text key={col.key} style={[a.th, { width: col.width }, i === SIGNER_COLS.length - 1 ? { borderRightWidth: 0 } : {}]}>
                {col.label}
              </Text>
            ))}
          </View>
          {input.signers.map((row, r) => (
            <View key={r} style={a.tr}>
              {SIGNER_COLS.map((col, i) => {
                const raw = col.key === "signedAt" ? (row.signedAt ? formatAuditTimestamp(row.signedAt) : "Not signed") : row[col.key];
                return (
                  <Text key={col.key} style={[a.td, { width: col.width }, i === SIGNER_COLS.length - 1 ? { borderRightWidth: 0 } : {}]}>
                    {pdfText(raw ?? "—") || "—"}
                  </Text>
                );
              })}
            </View>
          ))}
        </View>

        <View style={a.box}>
          <View wrap={false}>
            <Text style={a.bar}>Audit Events</Text>
            <View style={[a.tr, { borderTopWidth: 0 }]}>
              <Text style={[a.th, { width: "19%" }]}>Timestamp</Text>
              <Text style={[a.th, { width: "12%" }]}>Type</Text>
              <Text style={[a.th, { width: "69%", borderRightWidth: 0 }]}>Details</Text>
            </View>
          </View>
          {input.events.map((e, i) => (
            <View key={i} style={a.tr} wrap={false}>
              <Text style={[a.td, { width: "19%" }]}>{formatAuditTimestamp(e.at).replace(" America/New_York", " ET")}</Text>
              <Text style={[a.td, { width: "12%" }]}>{e.type}</Text>
              <Text style={[a.td, { width: "69%", borderRightWidth: 0 }]}>{pdfText(e.details)}</Text>
            </View>
          ))}
        </View>

        <Text style={a.footer} fixed>
          {pdfText(`${input.company.name} · Audit trail generated ${formatAuditTimestamp(input.generatedAt)} · Times are America/New_York (ET)`)}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderAuditTrailPdf(input: AuditTrailInput): Promise<Buffer> {
  const buf = await renderToBuffer(<AuditTrailDoc {...input} />);
  return stampPageNumbers(Buffer.from(buf));
}
