/**
 * E-signature end-to-end, against the REAL database and a local dev server.
 *
 * Uses an obvious test proposal ("Karan Test 1"). Nobody is pinged: run it with
 * Slack pointed at a dead address and the copy list narrowed, e.g.
 *
 *   COMMERCIAL_SLACK_WEBHOOK=http://127.0.0.1:9/off NEXT_PUBLIC_APP_URL=http://localhost:3000 \
 *   COMMERCIAL_PROPOSAL_COPY_EMAILS=developer@precisionpaintingplus.net npx next dev -p 3000
 *
 *   COMMERCIAL_SLACK_WEBHOOK=http://127.0.0.1:9/off COMMERCIAL_PROPOSAL_COPY_EMAILS=developer@precisionpaintingplus.net \
 *   node --env-file=.env.local node_modules/.bin/vitest run -c scripts/vitest.live.config.ts scripts/esign.live.test.ts
 *
 * ESIGN_E2E_PROPOSAL overrides the proposal id (it must be `sent` with a snapshot).
 */
import { it } from "vitest";
import { deflateSync, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import * as db from "@/lib/commercial/esign/db";
import * as wf from "@/lib/commercial/esign/workflow";

const BASE = "http://localhost:3000";
const PROPOSAL = process.env.ESIGN_E2E_PROPOSAL || "51c73997-2f54-4a85-90a5-b58653ec76a9";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let fails = 0;
const check = (label: string, cond: boolean, extra: string = "") => { console.log(`${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`); if (!cond) fails++; };

function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const on = Math.abs(y - (h / 2 + Math.sin(x / 18) * h / 4)) < 3;
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 23; raw[o + 1] = 43; raw[o + 2] = 77; raw[o + 3] = on ? 255 : 0;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const post = (token: string, body: Record<string, unknown>, ip = "203.0.113.7") =>
  fetch(`${BASE}/api/sign/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "esign-e2e/1.0 (iPhone test)" }, body: JSON.stringify(body) });


it("proposal e-signature works end to end against the real database", async () => {
  const { data: devRow } = await sb.from("profiles").select("user_id,email,full_name").eq("email", "developer@precisionpaintingplus.net").single();
  const dev = devRow as { user_id: string; email: string };
  const requestedBy = { userId: dev.user_id, name: "E2E Test", email: dev.email };

  // 1. Two links on the same proposal (a re-send).
  const a = await db.createSignatureRequest({ proposalId: PROPOSAL, signerEmail: "developer@precisionpaintingplus.net", signerName: "E2E Signer", requestedBy });
  const b = await db.createSignatureRequest({ proposalId: PROPOSAL, signerEmail: "developer+cc@precisionpaintingplus.net", signerName: null, requestedBy });
  check("two signing links issued", a.ok && b.ok, a.ok ? "" : a.error);
  if (!a.ok || !b.ok) throw new Error("could not issue links");
  console.log(`   request A ${a.request.id}`);

  // 2. Public page + document.
  const page = await fetch(`${BASE}/sign/${a.token}`);
  const html = await page.text();
  check("public signing page renders (no login)", page.status === 200 && html.includes("Sign &amp; accept"), `HTTP ${page.status}`);
  const junk = await fetch(`${BASE}/sign/${"x".repeat(43)}`);
  check("unknown token shows 'isn't valid', not a 500", junk.status === 200 && (await junk.text()).includes("isn"), `HTTP ${junk.status}`);
  const doc = await fetch(`${BASE}/api/sign/${a.token}/document`);
  const docBytes = Buffer.from(await doc.arrayBuffer());
  check("document served is byte-identical to the hashed snapshot", doc.status === 200 && sha(docBytes) === a.request.document_sha256, `HTTP ${doc.status}`);

  // 3. View twice (dedupe), consent, bad submits.
  await post(a.token, { action: "view" }); await post(a.token, { action: "view" });
  await post(a.token, { action: "consent" });
  const noConsent = await post(a.token, { action: "sign", name: "E2E Signer", title: "PM", company: "Karan Test 1", method: "drawn", signature: `data:image/png;base64,${png(500, 140).toString("base64")}`, consent: false });
  check("sign without consent refused 400", noConsent.status === 400);
  const huge = await post(a.token, { action: "sign", name: "E2E Signer", title: "", company: "", method: "drawn", signature: `data:image/png;base64,${(() => { const p = png(10, 10); p.writeUInt32BE(30000, 16); return p.toString("base64"); })()}`, consent: true });
  check("PNG declaring 30000px refused", huge.status === 400);

  // 4. Sign for real.
  const sigPng = png(500, 140);
  const signed = await post(a.token, { action: "sign", name: "E2E Signer", title: "Project Manager", company: "Karan Test 1", method: "drawn", signature: `data:image/png;base64,${sigPng.toString("base64")}`, consent: true });
  check("customer signature accepted", signed.status === 200, `HTTP ${signed.status} ${signed.status !== 200 ? await signed.text() : ""}`);
  const again = await post(a.token, { action: "sign", name: "E2E Signer", title: "", company: "", method: "drawn", signature: `data:image/png;base64,${sigPng.toString("base64")}`, consent: true });
  check("second submit on same link refused 409", again.status === 409, `HTTP ${again.status}`);
  const sibling = await post(b.token, { action: "sign", name: "Other", title: "", company: "", method: "drawn", signature: `data:image/png;base64,${sigPng.toString("base64")}`, consent: true });
  check("the other link for the same proposal can no longer sign", sibling.status === 409, `HTTP ${sibling.status}`);

  let A = (await db.getSignatureRequest(a.request.id))!;
  const B = (await db.getSignatureRequest(b.request.id))!;
  check("request A is awaiting countersignature", A.status === "awaiting_countersign");
  check("signature image hash stored and matches", A.customer_signature_sha256 === sha(sigPng));
  check("IP + browser recorded from headers", A.customer_ip === "203.0.113.7" && !!A.customer_user_agent?.includes("esign-e2e"));
  check("sibling link B was voided with a reason", B.status === "voided" && !!B.void_reason, B.status);
  let ev = await db.listSignatureEvents(a.request.id);
  check("VIEW recorded once despite two opens", ev.filter((e) => e.type === "VIEW").length === 1, ev.map((e) => e.type).join(","));
  check("CREATE, CONSENT, SUBMIT all present", ["CREATE", "CONSENT", "SUBMIT"].every((t) => ev.some((e) => e.type === t)));

  // 5. after() side effects: audit trail filed to the deal.
  for (let i = 0; i < 20 && !A.audit_document_id; i++) { await new Promise((r) => setTimeout(r, 1500)); A = (await db.getSignatureRequest(a.request.id))!; }
  check("audit trail PDF filed to the deal after signing", !!A.audit_document_id);

  // 6. Countersign with no company signature on file → refused, nothing changes.
  const refused = await wf.countersignProposal({ requestId: A.id, user: { id: dev.user_id, email: dev.email, name: "E2E Approver" }, meta: { ip: "198.51.100.9", userAgent: "esign-e2e approver" } });
  check("countersign refused while no signature is on file", !refused.ok && /signature on file/i.test(refused.error), refused.ok ? "unexpectedly ok" : refused.error);
  check("request still awaiting countersignature", ((await db.getSignatureRequest(A.id))!).status === "awaiting_countersign");

  // 7. Complete it with a test contractor signature (the settings asset stays untouched).
  const rec = await db.recordCountersignature({ requestId: A.id, user: { id: dev.user_id, email: dev.email }, signerName: "E2E Approver", signerTitle: "VP", meta: { ip: "198.51.100.9", userAgent: "esign-e2e approver" } });
  check("countersignature recorded", rec.ok, rec.ok ? "" : rec.error);
  const filed = await wf.finalizeCompletedRequest(A.id, { snapshot: docBytes, companySignature: png(420, 120) });
  check("signed contract + audit trail filed", filed === true);
  A = (await db.getSignatureRequest(A.id))!;
  const signedBytes = await (A.signed_document_id ? db.downloadDocumentBytes(A.signed_document_id) : null);
  check("stored signed PDF hashes to signed_sha256", !!signedBytes && sha(signedBytes) === A.signed_sha256);
  const snapPages = (await PDFDocument.load(docBytes)).getPageCount();
  const signedPages = signedBytes ? (await PDFDocument.load(signedBytes)).getPageCount() : 0;
  check("signed PDF = every snapshot page + one signature page", signedPages === snapPages + 1, `${snapPages} → ${signedPages}`);
  const { data: auditVersions } = await sb.from("commercial_documents").select("id,version,status").eq("parent_id", A.opportunity_id).eq("category", "esign_audit");
  check("audit trail re-filed as a new version (one document, history behind it)", (auditVersions ?? []).some((d) => d.version >= 2), JSON.stringify(auditVersions?.map((d) => d.version)));
  ev = await db.listSignatureEvents(A.id);
  check("COUNTERSIGN + COMPLETE events recorded", ["COUNTERSIGN", "COMPLETE"].every((t) => ev.some((e) => e.type === t)), ev.map((e) => e.type).join(","));
  const retry = await wf.finalizeCompletedRequest(A.id);
  const ev2 = await db.listSignatureEvents(A.id);
  check("retrying the filing does not file a second contract", retry === true && ev2.filter((e) => e.type === "COMPLETE").length === 1);

  // 8. Public link after completion serves the SIGNED copy.
  const after = await fetch(`${BASE}/api/sign/${a.token}/document`);
  check("customer link now returns the signed copy", sha(Buffer.from(await after.arrayBuffer())) === A.signed_sha256);

  // 9. Staff routes require login.
  const anon = await fetch(`${BASE}/api/commercial/signatures/${A.id}/audit`);
  check("audit trail route refuses anonymous callers", anon.status === 401, `HTTP ${anon.status}`);

  // 10. Append-only trail.
  const firstEvent = ev2[0];
  const { error: updErr } = await sb.from("commercial_signature_events").update({ details: "tampered" }).eq("id", firstEvent.id);
  check("audit event UPDATE refused by the database", !!updErr, updErr?.message);
  const { error: delErr } = await sb.from("commercial_signature_events").delete().eq("id", firstEvent.id);
  check("audit event DELETE refused by the database", !!delErr, delErr?.message);

  // Tidy the in-app bells this test raised on real people's accounts.
  const { count } = await sb.from("notifications").delete({ count: "exact" }).eq("work_order_id", PROPOSAL).in("kind", ["commercial_proposal_signed", "commercial_proposal_fully_signed", "commercial_proposal_signature_declined"]);
  console.log(`   removed ${count ?? 0} test bell notification(s)`);

  console.log(fails ? `\n❌ ${fails} check(s) failed` : "\n✅ e-signature end-to-end: every check passed");
  if (fails) throw new Error(`${fails} e-signature check(s) failed`);
});
