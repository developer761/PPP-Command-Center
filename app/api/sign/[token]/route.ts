import { NextResponse, after } from "next/server";
import { checkRateLimit, sweepRateLimit } from "@/lib/rate-limit";
import { isSignatureTokenShaped, DECLINE_REASON_MAX } from "@/lib/commercial/esign/constants";
import {
  closedLinkMessage,
  declineSignature,
  lookupSignatureLink,
  recordCustomerPresence,
  submitCustomerSignature,
} from "@/lib/commercial/esign/db";
import { afterCustomerDeclined, afterCustomerSigned } from "@/lib/commercial/esign/workflow";
import { clientMeta } from "@/lib/commercial/esign/request-meta";

/**
 * Public e-signature endpoint — the token IS the auth.
 *
 *   POST /api/sign/[token]  { action: "view" }       → VIEW event
 *                           { action: "consent" }    → CONSENT event
 *                           { action: "sign", ... }  → signature recorded
 *                           { action: "decline", reason }
 *
 * VIEW is posted by the page once it has actually rendered in a browser, not
 * on the server render: mail-security scanners fetch every link in an inbox,
 * and a trail that says the GC "viewed" the proposal at the moment their spam
 * filter did would be false evidence.
 *
 * IP and browser are read from the request here, never from the body.
 */

// Filing the audit trail + emails run in after(); give them room.
export const maxDuration = 60;

const MAX_BODY_BYTES = 800 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isSignatureTokenShaped(token)) {
    return NextResponse.json({ error: "This signing link isn't valid." }, { status: 404 });
  }

  const meta = clientMeta(request.headers);
  if (Math.random() < 0.03125) sweepRateLimit();
  const limit = checkRateLimit(`esign:${token}:${meta.ip ?? "?"}`, { max: 20, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attempts — please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } }
    );
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "That signature image is too large — clear it and sign again." }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "That signature image is too large — clear it and sign again." }, { status: 413 });
    }
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Something went wrong sending that — please try again." }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  switch (body.action) {
    case "view":
    case "consent": {
      const lookup = await lookupSignatureLink(token);
      if (!lookup.found) {
        return NextResponse.json({ error: "This signing link isn't valid." }, { status: lookup.reason === "unavailable" ? 503 : 404 });
      }
      if (lookup.state.kind !== "sign") {
        return NextResponse.json({ error: closedLinkMessage(lookup.state) }, { status: 409 });
      }
      await recordCustomerPresence(lookup, body.action === "view" ? "VIEW" : "CONSENT", meta);
      return NextResponse.json({ ok: true });
    }

    case "sign": {
      const png = decodePngDataUrl(str(body.signature));
      const result = await submitCustomerSignature({
        token,
        name: str(body.name),
        title: str(body.title),
        company: str(body.company),
        method: str(body.method) === "drawn" ? "drawn" : str(body.method) === "typed" ? "typed" : ("" as "typed"),
        png: png ?? new Uint8Array(),
        consent: body.consent === true,
        meta,
      });
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      after(() => afterCustomerSigned(result.request, result.proposal));
      return NextResponse.json({ ok: true, signedAt: result.request.customer_signed_at });
    }

    case "decline": {
      const result = await declineSignature({ token, reason: str(body.reason).slice(0, DECLINE_REASON_MAX), meta });
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      after(() => afterCustomerDeclined(result.request, result.proposal));
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}

function decodePngDataUrl(v: string): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (!m) return null;
  try {
    return new Uint8Array(Buffer.from(m[1], "base64"));
  } catch {
    return null;
  }
}
