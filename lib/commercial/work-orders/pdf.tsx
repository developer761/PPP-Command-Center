import "server-only";

import { Document, Page, View, Text, Image, StyleSheet, Font, renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";
import type { WorkOrderContent, WorkOrderScopeLine, WorkOrderFinishRow } from "./db";

Font.registerHyphenationCallback((word) => [word]);

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 54, paddingHorizontal: 54, fontSize: 10, fontFamily: "Helvetica", color: "#1f2937", lineHeight: 1.4 },
  wordmark: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: 1, textAlign: "center", color: "#172B4D" },
  logoImage: { height: 42, objectFit: "contain", alignSelf: "center", marginBottom: 2 },
  sigImage: { height: 40, objectFit: "contain", marginBottom: 2, alignSelf: "flex-start" },
  contact: { fontSize: 7.5, textAlign: "center", color: "#9ca3af", marginTop: 3, letterSpacing: 0.3 },
  rule: { borderBottomWidth: 2, borderBottomColor: "#EE662E", marginTop: 12, marginBottom: 18 },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 },
  h2: { fontSize: 10.5, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.6, color: "#172B4D", marginTop: 16, marginBottom: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 14 },
  label: { fontSize: 7.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  bold: { fontFamily: "Helvetica-Bold" },
  phase: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: "#374151", marginTop: 8, marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.5 },
  li: { flexDirection: "row", paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: "#f0f0f0" },
  liQty: { width: "16%", color: "#6b7280", fontSize: 9 },
  liDesc: { width: "84%" },
  ex: { flexDirection: "row", paddingVertical: 1.5 },
  exBullet: { width: 12, color: "#9ca3af" },
  // finish grid
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#111827", paddingBottom: 4, marginBottom: 2, marginTop: 2 },
  th: { fontSize: 7.5, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.4, color: "#374151" },
  tr: { flexDirection: "row", paddingVertical: 3.5, borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  cCode: { width: "12%" },
  cLoc: { width: "26%" },
  cProd: { width: "34%" },
  cSheen: { width: "16%" },
  cType: { width: "12%" },
  muted: { color: "#9ca3af" },
  para: { marginBottom: 8 },
  sig: { marginTop: 34, borderTopWidth: 1, borderTopColor: "#111827", width: 240, paddingTop: 4 },
  footer: { position: "absolute", bottom: 30, left: 54, right: 54, fontSize: 7.5, color: "#9ca3af", textAlign: "center", borderTopWidth: 0.5, borderTopColor: "#e5e7eb", paddingTop: 6 },
});

export type CompanyContact = { name: string; phone?: string | null; website?: string | null };

export type WorkOrderPdfInput = {
  content: WorkOrderContent;
  header: {
    dealName: string;
    gcCompany: string | null;
    projectAddress: string | null;
    assignedTo: string | null;
    scheduledStartDate: string | null;
    workNotes: string | null;
    dateIso: string;
  };
  company: CompanyContact;
  logo?: Buffer | null;
  signature?: Buffer | null;
};

function fmtDate(ymd: string | null): string {
  if (!ymd) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[parseInt(m[2]!, 10) - 1]} ${parseInt(m[3]!, 10)}, ${m[1]}`;
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

/** Group scope lines by phase (null phase → "General"), preserving order. */
function groupByPhase(lines: WorkOrderScopeLine[]): { phase: string; lines: WorkOrderScopeLine[] }[] {
  const groups: { phase: string; lines: WorkOrderScopeLine[] }[] = [];
  const byKey = new Map<string, { phase: string; lines: WorkOrderScopeLine[] }>();
  for (const l of lines) {
    const key = l.phase?.trim() || "General";
    let g = byKey.get(key);
    if (!g) {
      g = { phase: key, lines: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.lines.push(l);
  }
  return groups;
}

function qtyLabel(l: WorkOrderScopeLine): string {
  if (l.is_labor) return "Labor";
  const q = Number.isFinite(l.quantity) ? l.quantity : 0;
  const qStr = Number.isInteger(q) ? String(q) : q.toFixed(2);
  return `${qStr} ${l.unit || ""}`.trim();
}

function ScopeList({ lines }: { lines: WorkOrderScopeLine[] }) {
  const grouped = groupByPhase(lines);
  const showPhaseHeaders = grouped.length > 1 || (grouped[0]?.phase !== "General");
  return (
    <View>
      {grouped.map((g, gi) => (
        <View key={gi}>
          {showPhaseHeaders ? <Text style={styles.phase}>{g.phase}</Text> : null}
          {g.lines.map((l, i) => (
            <View key={i} style={styles.li}>
              <Text style={styles.liQty}>{qtyLabel(l)}</Text>
              <Text style={styles.liDesc}>
                {l.product_name ? <Text style={styles.bold}>{l.product_name}{l.description ? " — " : ""}</Text> : null}
                {l.description}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function FinishGrid({ rows }: { rows: WorkOrderFinishRow[] }) {
  return (
    <View>
      <View style={styles.tableHead}>
        <Text style={[styles.th, styles.cCode]}>Code</Text>
        <Text style={[styles.th, styles.cLoc]}>Location</Text>
        <Text style={[styles.th, styles.cProd]}>Product / Color</Text>
        <Text style={[styles.th, styles.cSheen]}>Sheen</Text>
        <Text style={[styles.th, styles.cType]}>Type</Text>
      </View>
      {rows.map((r, i) => {
        const prod = [r.manufacturer, r.product_name, r.color].filter(Boolean).join(" · ");
        return (
          <View key={i} style={styles.tr} wrap={false}>
            <Text style={[styles.cCode, styles.bold]}>{r.code}</Text>
            <Text style={styles.cLoc}>{r.location_description || <Text style={styles.muted}>—</Text>}</Text>
            <Text style={styles.cProd}>{prod || <Text style={styles.muted}>—</Text>}</Text>
            <Text style={styles.cSheen}>{r.sheen || <Text style={styles.muted}>—</Text>}</Text>
            <Text style={styles.cType}>{r.finish_type || <Text style={styles.muted}>—</Text>}</Text>
          </View>
        );
      })}
    </View>
  );
}

function WorkOrderDoc({ content, header, company, logo, signature }: WorkOrderPdfInput) {
  const { inclusions, alternates, exclusions, finishes } = content;
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <LogoBlock company={company} logo={logo} />

        <View style={styles.row}>
          <View style={{ width: "60%" }}>
            <Text style={styles.label}>Project</Text>
            <Text style={styles.bold}>{header.dealName || "—"}</Text>
            {header.gcCompany ? <Text>{header.gcCompany}</Text> : null}
            {header.projectAddress ? <Text style={styles.muted}>{header.projectAddress}</Text> : null}
          </View>
          <View style={{ width: "35%", textAlign: "right" }}>
            <Text style={styles.label}>Date</Text>
            <Text style={styles.bold}>{fmtDate(header.dateIso.slice(0, 10))}</Text>
            {header.assignedTo ? (
              <>
                <Text style={[styles.label, { marginTop: 8 }]}>Crew</Text>
                <Text>{header.assignedTo}</Text>
              </>
            ) : null}
            {header.scheduledStartDate ? (
              <>
                <Text style={[styles.label, { marginTop: 8 }]}>Start</Text>
                <Text>{fmtDate(header.scheduledStartDate)}</Text>
              </>
            ) : null}
          </View>
        </View>

        <Text style={styles.h1}>Work Order</Text>

        {content.no_proposal ? (
          <Text style={[styles.para, styles.muted]}>
            No proposal is attached to this job yet — scope will populate here once a proposal exists. The finish
            schedule below (if any) still applies.
          </Text>
        ) : null}

        {inclusions.length > 0 ? (
          <View>
            <Text style={styles.h2}>Scope of Work</Text>
            <ScopeList lines={inclusions} />
          </View>
        ) : null}

        {alternates.length > 0 ? (
          <View>
            <Text style={styles.h2}>Alternates</Text>
            <ScopeList lines={alternates} />
          </View>
        ) : null}

        {exclusions.length > 0 ? (
          <View>
            <Text style={styles.h2}>Exclusions</Text>
            {exclusions.map((e, i) => (
              <View key={i} style={styles.ex}>
                <Text style={styles.exBullet}>•</Text>
                <Text style={{ width: "94%" }}>{e}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {finishes.length > 0 ? (
          <View>
            <Text style={styles.h2}>Room Finish Schedule</Text>
            <FinishGrid rows={finishes} />
          </View>
        ) : null}

        {header.workNotes ? (
          <View>
            <Text style={styles.h2}>Crew Notes</Text>
            <Text>{header.workNotes}</Text>
          </View>
        ) : null}

        <View style={styles.sig}>
          {signature ? <Image src={signature} style={styles.sigImage} /> : null}
          <View style={{ borderTopWidth: signature ? 0 : 1, borderTopColor: "#9ca3af", width: 220, paddingTop: 2 }}>
            <Text style={styles.bold}>{company.name}</Text>
            <Text style={{ fontSize: 8, color: "#6b7280" }}>Authorized signature</Text>
          </View>
        </View>

        <Text style={styles.footer}>{company.name} · Work Order</Text>
      </Page>
    </Document>
  );
}

export async function renderWorkOrderPdf(input: WorkOrderPdfInput): Promise<Buffer> {
  return renderToBuffer(<WorkOrderDoc {...input} />);
}
