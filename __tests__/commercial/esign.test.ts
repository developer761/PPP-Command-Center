import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  isSignatureTokenShaped,
  resolveLinkState,
  formatAuditTimestamp,
  SIGNATURE_REQUEST_STATUSES,
} from "@/lib/commercial/esign/constants";
import { generateSignatureToken, hashSignatureToken, sha256Hex } from "@/lib/commercial/esign/token";
import { validateSignerFields } from "@/lib/commercial/esign/db";
import { summarizeSignatures, formatDuration } from "@/lib/commercial/esign/report";
import { pdfText, renderSignaturePagePdf, assembleSignedDocument, renderAuditTrailPdf } from "@/lib/commercial/esign/pdf";
import { clientMeta } from "@/lib/commercial/esign/request-meta";
import { isPublicPath } from "@/components/install-app-prompt";
import { countersignBlockedReason, isPngOrJpeg } from "@/lib/commercial/esign/workflow";

/**
 * Proposal e-signature. The rules that decide whether a legal signature can be
 * taken, and the documents it produces — rendered and measured, not grepped.
 */

// 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const NOW = new Date("2026-09-15T17:00:00Z");
const FUTURE = "2026-10-15T17:00:00Z";
const PAST = "2026-09-14T17:00:00Z";

describe("resolveLinkState — when a signing link can take a signature", () => {
  const base = { status: "awaiting_customer" as const, expiresAt: FUTURE, proposalStatus: "sent", proposalDeleted: false, now: NOW };

  it("an open link on a sent proposal can be signed", () => {
    expect(resolveLinkState(base)).toEqual({ kind: "sign" });
  });

  it("a proposal already marked WON is still signable — verbal yes, paperwork follows", () => {
    expect(resolveLinkState({ ...base, proposalStatus: "won" }).kind).toBe("sign");
  });

  it.each(["superseded", "lost", "draft", "expired", "approved", "pending_approval"])(
    "a %s proposal voids the link and persists the void",
    (proposalStatus) => {
      const s = resolveLinkState({ ...base, proposalStatus });
      expect(s.kind).toBe("voided");
      expect(s.kind === "voided" && s.persist).toBe(true);
    }
  );

  it("a deleted proposal (or deal) voids the link", () => {
    expect(resolveLinkState({ ...base, proposalDeleted: true }).kind).toBe("voided");
  });

  it("expiry is checked AFTER the proposal: a replaced proposal says why, not just 'expired'", () => {
    const s = resolveLinkState({ ...base, expiresAt: PAST, proposalStatus: "superseded" });
    expect(s.kind).toBe("voided");
  });

  it("a link past its expiry expires, exactly at the boundary too", () => {
    expect(resolveLinkState({ ...base, expiresAt: PAST }).kind).toBe("expired");
    expect(resolveLinkState({ ...base, expiresAt: NOW.toISOString() }).kind).toBe("expired");
  });

  it("closed statuses never become signable again, whatever the proposal says", () => {
    for (const status of SIGNATURE_REQUEST_STATUSES.filter((s) => s !== "awaiting_customer")) {
      expect(resolveLinkState({ ...base, status }).kind, status).not.toBe("sign");
      // …and don't try to re-persist a state they're already in.
      const s = resolveLinkState({ ...base, status });
      if (s.kind === "voided" || s.kind === "expired") expect(s.persist).toBe(false);
    }
  });
});

describe("signing-link tokens", () => {
  it("are 43-char base64url, and only the hash is derived for storage", () => {
    const a = generateSignatureToken();
    const b = generateSignatureToken();
    expect(isSignatureTokenShaped(a.token)).toBe(true);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashSignatureToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
  });

  it("junk never reaches the database", () => {
    for (const bad of ["", "short", "x".repeat(42), "x".repeat(44), `${"a".repeat(42)}/`, null, undefined]) {
      expect(isSignatureTokenShaped(bad as string)).toBe(false);
    }
  });

  it("sha256Hex matches a known vector", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("validateSignerFields — what the public endpoint accepts", () => {
  const ok = { name: "Maria Irigaray", title: "PM", company: "S&J Electric", method: "typed", png: new Uint8Array(PNG), consent: true };

  it("accepts a real signature", () => {
    expect(validateSignerFields(ok)).toBeNull();
  });
  it("requires consent to sign electronically", () => {
    expect(validateSignerFields({ ...ok, consent: false })).toMatch(/electronically/);
  });
  it("requires a name", () => {
    expect(validateSignerFields({ ...ok, name: " a " })).toMatch(/name/);
  });
  it("rejects a non-PNG body pretending to be a signature", () => {
    expect(validateSignerFields({ ...ok, png: new Uint8Array(Buffer.from("<svg onload=alert(1)>")) })).toMatch(/didn't come through/);
  });
  it("rejects an unknown method and an empty image", () => {
    expect(validateSignerFields({ ...ok, method: "stamped" })).not.toBeNull();
    expect(validateSignerFields({ ...ok, png: new Uint8Array() })).not.toBeNull();
  });
  it("rejects an oversized image", () => {
    const big = new Uint8Array(500 * 1024);
    big.set(PNG.subarray(0, 8));
    expect(validateSignerFields({ ...ok, png: big })).toMatch(/too large/);
  });
});

describe("clientMeta — IP and browser for the trail", () => {
  it("takes the first forwarded address and caps attacker-controlled length", () => {
    const h = new Headers({ "x-forwarded-for": "73.199.1.225, 10.0.0.1", "user-agent": "x".repeat(2000) });
    const m = clientMeta(h);
    expect(m.ip).toBe("73.199.1.225");
    expect(m.userAgent?.length).toBe(512);
  });
  it("falls back to x-real-ip, then null", () => {
    expect(clientMeta(new Headers({ "x-real-ip": "1.2.3.4" })).ip).toBe("1.2.3.4");
    expect(clientMeta(new Headers()).ip).toBeNull();
  });
});

describe("summarizeSignatures — counted per proposal, not per link", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 8, 1, h)).toISOString();

  it("a proposal re-sent three times and signed once is ONE sent, ONE signed", () => {
    const s = summarizeSignatures([
      { proposal_id: "p1", status: "voided", created_at: t(0), customer_signed_at: null, countersigned_at: null },
      { proposal_id: "p1", status: "voided", created_at: t(1), customer_signed_at: null, countersigned_at: null },
      { proposal_id: "p1", status: "completed", created_at: t(2), customer_signed_at: t(6), countersigned_at: t(8) },
    ]);
    expect(s.proposalsSent).toBe(1);
    expect(s.proposalsSigned).toBe(1);
    expect(s.fullySigned).toBe(1);
    expect(s.signRatePct).toBe(100);
    expect(s.medianHoursToSign).toBe(4);
    expect(s.medianHoursToCountersign).toBe(2);
  });

  it("splits waiting-on-customer, waiting-on-us and declined", () => {
    const s = summarizeSignatures([
      { proposal_id: "a", status: "awaiting_customer", created_at: t(0), customer_signed_at: null, countersigned_at: null },
      { proposal_id: "b", status: "awaiting_countersign", created_at: t(0), customer_signed_at: t(3), countersigned_at: null },
      { proposal_id: "c", status: "declined", created_at: t(0), customer_signed_at: null, countersigned_at: null },
      { proposal_id: "d", status: "expired", created_at: t(0), customer_signed_at: null, countersigned_at: null },
    ]);
    expect(s).toMatchObject({ proposalsSent: 4, proposalsSigned: 1, awaitingCustomer: 1, awaitingCountersign: 1, declined: 1, fullySigned: 0, signRatePct: 25 });
  });

  it("an empty window has no rate rather than 0%", () => {
    expect(summarizeSignatures([]).signRatePct).toBeNull();
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0.25)).toBe("15m");
    expect(formatDuration(72)).toBe("3d");
  });
});

describe("pdfText — Helvetica is WinAnsi; a stranger's name is not", () => {
  it("keeps Latin-1 and WinAnsi punctuation, replaces what can't print", () => {
    expect(pdfText("Zoë O’Sullivan — Müller")).toBe("Zoë O’Sullivan — Müller");
    expect(pdfText("李伟")).toBe("??");
    expect(pdfText("6′ − 2″")).toBe(`6' - 2"`);
    expect(pdfText(null)).toBe("");
  });
});

describe("the documents a signature produces — rendered and measured", () => {
  const company = { name: "Tomco Painting", address_lines: ["1 Main St", "Islip, NY 11751"], phone: "631-555-0100", website: "tomcopainting.com" };

  async function onePageSnapshot(): Promise<Buffer> {
    const d = await PDFDocument.create();
    d.addPage([612, 792]).drawText("PROPOSAL BODY");
    return Buffer.from(await d.save());
  }

  const sigInput = (contractor: boolean) => ({
    company,
    requestId: "11111111-1111-1111-1111-111111111111",
    proposalLabel: "Proposal R1",
    proposalNumber: "2026-0042",
    projectName: "Nordstrom Rack — Holbrook",
    gcCompany: "ARCADIS",
    proposalDate: "2026-09-15",
    documentSha256: "d86fbd4e478541af3d8d90992b7fc6eb8009e3bef1c49891f1f720f6601505c4",
    customer: { name: "Zoë Müller 李", title: "Project Manager", company: "ARCADIS", email: "z@arcadis.com", signedAt: "2026-09-15T17:17:36Z", signature: PNG },
    contractor: contractor ? { name: "Brendan Dwyer", title: "VP", signedAt: "2026-09-15T17:26:32Z", signature: PNG } : null,
  });

  it("the signature page is ONE Letter page, pending or countersigned", async () => {
    for (const contractor of [false, true]) {
      const doc = await PDFDocument.load(new Uint8Array(await renderSignaturePagePdf(sigInput(contractor))));
      expect(doc.getPageCount()).toBe(1);
      const p = doc.getPage(0);
      expect([Math.round(p.getWidth()), Math.round(p.getHeight())]).toEqual([612, 792]);
    }
  });

  it("the signed contract is every snapshot page, then the signature page — and hashes differently from the snapshot", async () => {
    const snapshot = await onePageSnapshot();
    const signed = await assembleSignedDocument(snapshot, await renderSignaturePagePdf(sigInput(true)));
    const doc = await PDFDocument.load(new Uint8Array(signed));
    expect(doc.getPageCount()).toBe(2);
    expect(sha256Hex(signed)).not.toBe(sha256Hex(snapshot));

    // A multi-page snapshot keeps ALL of its pages, in front.
    const three = await PDFDocument.create();
    three.addPage([612, 792]);
    three.addPage([612, 792]);
    three.addPage([612, 1000]);
    const assembled = await PDFDocument.load(
      new Uint8Array(await assembleSignedDocument(Buffer.from(await three.save()), await renderSignaturePagePdf(sigInput(true))))
    );
    expect(assembled.getPageCount()).toBe(4);
    expect(Math.round(assembled.getPage(2).getHeight())).toBe(1000);
  });

  const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
  const ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
  const tag = "[Profile: Customer | Signing position: 1/2]";
  // The event copy db.ts/workflow.ts actually writes, for one complete signing.
  const ONE_SIGNING: Array<[string, string]> = [
    ["CREATE", "Kim Estimator (kim@tomcopainting.com) created an e-signature request for Proposal R1 — Nordstrom Rack Holbrook and fingerprinted the proposal PDF (SHA-256 above)."],
    ["EMAIL", `Signing link emailed to mirigaray@sandjelectric.com (cc pm@sandjelectric.com) ${tag} with the proposal PDF attached.`],
    ["VIEW", `Signing page intended for mirigaray@sandjelectric.com ${tag} opened from a device with IP address 73.199.1.225 and browser with user agent string ${win}.`],
    ["CONSENT", `Consent to do business electronically given on the signing page intended for mirigaray@sandjelectric.com ${tag}.`],
    ["SUBMIT", `Document reviewed and signed by Maria Irigaray, Project Manager (S&J Electric) on the signing page intended for mirigaray@sandjelectric.com ${tag}, from a device with IP address 73.199.1.225 and browser with user agent string ${win}. Signature typed; the document's SHA-256 matched the copy sent.`],
    ["EMAIL", `Sent confirmation of the signature to mirigaray@sandjelectric.com ${tag}.`],
    ["COUNTERSIGN", `Countersigned as Brendan Dwyer, VP by brendan@tomcopainting.com [Profile: Contractor | Signing position: 2/2] using the signature on file, from a device with IP address 69.113.166.104 and browser with user agent string ${ios}.`],
    ["COMPLETE", "Created the signed document (proposal + signature page) and stored it with Document ID 068b2c1e-7d0a-4c41-9f3e-3c1f5f2b9a77. Its SHA-256 is the Unique ID above."],
    ["EMAIL", `Sent the fully signed document and audit trail to mirigaray@sandjelectric.com ${tag}.`],
  ];

  const auditInput = (events: Array<[string, string]>) => ({
    company,
    requestId: "11111111-1111-1111-1111-111111111111",
    documentTitle: "Proposal R1 — Nordstrom Rack Holbrook",
    statusLabel: "Fully signed",
    documentSha256: "a".repeat(64),
    signedSha256: "b".repeat(64),
    requestedBy: "Kim Estimator (kim@tomcopainting.com)",
    createdFrom: "https://hub.precisionpaintingplus.net/commercial",
    signedAt: "https://hub.precisionpaintingplus.net/sign/",
    signers: [
      { name: "Maria Irigaray", email: "mirigaray@sandjelectric.com", profile: "Customer", position: "1/2", ip: "73.199.1.225", signedAt: "2026-09-15T17:17:36Z" },
      { name: "Brendan Dwyer", email: "brendan@tomcopainting.com", profile: "Tomco Painting Representative", position: "2/2", ip: "69.113.166.104", signedAt: "2026-09-15T17:26:32Z" },
    ],
    events: events.map(([type, details], i) => ({ at: new Date(Date.UTC(2026, 8, 15, 17, i)).toISOString(), type, details })),
    generatedAt: "2026-09-15T18:00:00Z",
  });

  it("one complete signing (9 events, real copy, long browser strings) is ONE page", async () => {
    const doc = await PDFDocument.load(new Uint8Array(await renderAuditTrailPdf(auditInput(ONE_SIGNING))));
    expect(doc.getPageCount()).toBe(1);
  });

  it("a long trail flows onto more pages instead of being cut off", async () => {
    const many = Array.from({ length: 6 }, () => ONE_SIGNING).flat();
    const doc = await PDFDocument.load(new Uint8Array(await renderAuditTrailPdf(auditInput(many))));
    expect(doc.getPageCount()).toBeGreaterThan(1);
    for (const p of doc.getPages()) expect(Math.round(p.getWidth())).toBe(612);
  });
});

describe("the install-app prompt stays off pages outsiders open", () => {
  it.each(["/sign/abc", "/select/abc", "/f/abc", "/c/bid-submit"])("%s is public", (p) => {
    expect(isPublicPath(p)).toBe(true);
  });
  it.each(["/commercial", "/dashboard", "/signatures", "/sign", null])("%s is not", (p) => {
    expect(isPublicPath(p as string | null)).toBe(false);
  });
});

describe("formatAuditTimestamp", () => {
  it("prints Eastern time in the S-Docs shape, across DST", () => {
    expect(formatAuditTimestamp("2026-09-15T17:17:36Z")).toBe("2026-09-15 01:17:36 PM America/New_York");
    expect(formatAuditTimestamp("2026-01-15T17:17:36Z")).toBe("2026-01-15 12:17:36 PM America/New_York");
  });
});

describe("countersignBlockedReason — a dead proposal never becomes a contract", () => {
  it("sent and won can be countersigned", () => {
    expect(countersignBlockedReason({ status: "sent", deleted_at: null })).toBeNull();
    expect(countersignBlockedReason({ status: "won", deleted_at: null })).toBeNull();
  });
  it.each(["superseded", "lost", "expired", "draft"])("a %s proposal is refused", (status) => {
    expect(countersignBlockedReason({ status, deleted_at: null })).toMatch(/can't be countersigned/);
  });
  it("a deleted proposal or deal is refused, and so is a missing one", () => {
    expect(countersignBlockedReason({ status: "sent", deleted_at: "2026-09-15T00:00:00Z" })).not.toBeNull();
    expect(countersignBlockedReason(null)).not.toBeNull();
  });
});

describe("the company signature must be printable", () => {
  it("accepts PNG and JPEG, refuses WEBP (react-pdf draws it as nothing)", () => {
    expect(isPngOrJpeg(PNG)).toBe(true);
    expect(isPngOrJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(true);
    expect(isPngOrJpeg(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe(false);
  });
});

describe("a PNG that declares a gigantic canvas is refused before it reaches the renderer", () => {
  it("rejects 20000×20000 in a tiny file; accepts a phone-sized signature", () => {
    const header = (w: number, h: number) => {
      const b = Buffer.from(PNG);
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      return new Uint8Array(b);
    };
    const base = { name: "Maria Irigaray", title: "", company: "", method: "drawn", consent: true };
    expect(validateSignerFields({ ...base, png: header(20000, 20000) })).toMatch(/too large/);
    expect(validateSignerFields({ ...base, png: header(1200, 300) })).toBeNull();
  });
});
