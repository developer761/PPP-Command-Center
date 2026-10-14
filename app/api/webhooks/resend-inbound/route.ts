import { NextResponse } from "next/server";
import { notifySupplierReply } from "@/lib/notifications/supplier-reply";
import { createHmac, timingSafeEqual } from "crypto";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import type {
  InboundPayload as ArchivePayload,
  InboundResult as ArchiveResult,
} from "@/lib/commercial/email-archive/inbound";
import { reportError, reportWarn } from "@/lib/observability";

/**
 * Resend inbound webhook — receives every email sent to
 * orders@orders.precisionpaintingplus.net and threads it into
 * inbox_messages.
 *
 *   POST /api/webhooks/resend-inbound
 *   Headers:
 *     svix-id, svix-timestamp, svix-signature  (Resend uses Svix)
 *   Body: JSON payload Resend sends (see https://resend.com/docs/dashboard/inbound)
 *
 * Threading priority:
 *   1. In-Reply-To header matches a known resend_message_id (in
 *      customer_form_tokens or supplier_orders) — most reliable.
 *   2. PO number (PPP-WO{n}-{supplier}-{seq}) appears in the subject —
 *      matches to supplier_orders.po_number.
 *   3. From-email matches a customer_form_tokens.customer_email with
 *      a recent sent timestamp — customer-reply attribution.
 *   4. None of the above → kind='unmatched', goes to the triage bucket.
 *
 * Idempotent — UNIQUE (resend_message_id) prevents double-ingest if Resend
 * retries the webhook. Returns 200 even when threading fails so Resend
 * doesn't keep retrying.
 *
 * WHY THE ARCHIVE IMPORT IS LAZY (2026-09-03)
 * This endpoint is SHARED: it carries residential supplier-order and
 * color-form replies as well as the Commercial BCC archive. It was returning
 * 500 to every request in production — GET included, where the identical-shape
 * sibling /api/webhooks/resend-events returns a clean 405 — which is the
 * signature of a module that fails to LOAD, not a handler that fails to run.
 * The one structural difference is this file's static import of a Commercial
 * module, which pulls isomorphic-dompurify and jsdom (declared in
 * serverExternalPackages, so resolved at runtime rather than bundled).
 *
 * A static import means any failure in that chain takes the whole webhook down,
 * including the residential path that has nothing to do with it — and it fails
 * invisibly, because a webhook nobody is watching just stops receiving. Resend
 * sees 500, retries, gives up. Materials-order replies have never landed:
 * inbox_messages has zero rows.
 *
 * So the archive is imported inside the handler and its failure is contained.
 * Commercial archiving behaves exactly as before when the import succeeds.
 *
 * Configuration in Resend dashboard:
 *   - Inbound address: orders@orders.precisionpaintingplus.net
 *   - Webhook URL: https://hub.precisionpaintingplus.net/api/webhooks/resend-inbound
 *   - Webhook secret: stored in RESEND_INBOUND_SECRET env var
 */

/**
 * Resend sends `from` as a STRING — "Acme <onboarding@resend.dev>" — and
 * `to` as an array of strings. This type accepted only the nested
 * `{ email, name }` shape, so `data.from?.email` was undefined on every real
 * delivery, the handler hit its `no_from` guard and returned 200 with
 * nothing stored.
 *
 * It returned 200, so Resend never retried and nothing ever alerted. Found
 * 2026-10-14 from Kate's "I don't see the vendor's replies in the hub": the
 * webhook had been answering 200 to every delivery and dropping all of them.
 * The one message in the table arrived on 2026-09-03, which is the last time
 * the payload matched this type.
 *
 * Both shapes are accepted now rather than swapping one guess for another —
 * the September row proves the nested form existed at least once, and a
 * webhook that silently discards mail is not something to be clever about.
 */
type ResendAddress = string | { email?: string; name?: string };

type ResendInboundPayload = {
  type?: string;
  data?: {
    email_id?: string;
    from?: ResendAddress;
    to?: ResendAddress[];
    subject?: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    message_id?: string;
    in_reply_to?: string;
    created_at?: string;
  };
};

/**
 * "Acme <onboarding@resend.dev>" → { email, name }, and the nested
 * `{ email, name }` form straight through.
 *
 * A bare "a@b.com" with no display name is the other common shape, so the
 * angle brackets are optional.
 */
export function parseAddress(v: unknown): { email: string | null; name: string | null } {
  if (!v) return { email: null, name: null };
  if (typeof v === "object") {
    const o = v as { email?: unknown; name?: unknown };
    return {
      email: typeof o.email === "string" && o.email.trim() ? o.email.trim() : null,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : null,
    };
  }
  if (typeof v !== "string") return { email: null, name: null };
  const s = v.trim();
  const angled = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].replace(/^["']|["']$/g, "").trim();
    return { email: angled[2].trim() || null, name: name || null };
  }
  return { email: s.includes("@") ? s : null, name: null };
}

/**
 * Fetch the parts the webhook deliberately leaves out.
 *
 * Resend's docs are explicit: "webhooks do not include the email body,
 * headers, or attachments, only their metadata." So the text we store in the
 * Mail Hub, and the In-Reply-To we thread on, both have to be pulled back.
 *
 *   GET https://api.resend.com/emails/receiving/{id}
 *
 * Soft. If the key is missing or the call fails we keep whatever the payload
 * carried and let the SUBJECT matcher thread it — a reply filed against the
 * right order with an empty body beats no reply at all. Never throws.
 */
async function fetchReceivedEmail(emailId: string | null | undefined): Promise<{
  text: string | null;
  html: string | null;
  headers: Record<string, string> | null;
  messageId: string | null;
} | null> {
  if (!emailId) return null;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    reportWarn({
      key: "resend_inbound_no_api_key",
      message: "RESEND_API_KEY not set — inbound replies will store without a body",
      platform: "shared",
    });
    return null;
  }
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) {
      reportWarn({
        key: "resend_inbound_fetch_failed",
        message: `Could not fetch inbound email ${emailId}: HTTP ${res.status}`,
        platform: "shared",
      });
      return null;
    }
    const j = (await res.json()) as {
      text?: string; html?: string;
      headers?: Record<string, string>; message_id?: string;
    };
    return {
      text: typeof j.text === "string" ? j.text : null,
      html: typeof j.html === "string" ? j.html : null,
      headers: j.headers ?? null,
      messageId: typeof j.message_id === "string" ? j.message_id : null,
    };
  } catch (err) {
    reportWarn({
      key: "resend_inbound_fetch_threw",
      message: `Fetching inbound email ${emailId} threw: ${err instanceof Error ? err.message : String(err)}`,
      platform: "shared",
    });
    return null;
  }
}

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Verify the Svix-style HMAC signature Resend includes on each webhook.
 * Returns true when the signature matches our stored secret. Skips
 * verification (logs a warning) when RESEND_INBOUND_SECRET isn't set so
 * local dev / first-deploy don't hard-fail; production should always have
 * the secret set.
 */
function verifySignature(
  rawBody: string,
  svixId: string | null,
  svixTimestamp: string | null,
  svixSignatureHeader: string | null
): boolean {
  // trim so a stray-whitespace env value (" ") is treated as unset rather
  // than a truthy garbage secret that 401s every real webhook (silent outage).
  const secret = process.env.RESEND_INBOUND_SECRET?.trim();
  if (!secret) {
    // In production this is a hard fail — accepting unsigned posts to a
    // public webhook lets anyone inject fake messages into the inbox. We
    // refuse to validate so the POST is rejected. In dev we warn + accept
    // so local testing works without the env var.
    if (process.env.NODE_ENV === "production") {
      console.error("[resend-inbound] RESEND_INBOUND_SECRET not set in production — refusing to accept unsigned webhooks");
      return false;
    }
    console.warn("[resend-inbound] RESEND_INBOUND_SECRET not set — webhook running UNSIGNED (dev only). Set the env var before going to prod.");
    return true;
  }
  if (!svixId || !svixTimestamp || !svixSignatureHeader) return false;
  // Reject replays: even with a valid signature, refuse webhooks whose
  // svix-timestamp is more than ±5 minutes from now. Without this an
  // attacker who captures a single signed POST (e.g. from logs) could
  // replay it months later and inject the same message body — the UNIQUE
  // constraint on resend_message_id catches duplicates but not crafted
  // collisions, and unmatched-bucket pollution is still annoying.
  const tsSeconds = Number(svixTimestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsSeconds);
  if (skewSeconds > 300) {
    console.warn(`[resend-inbound] rejecting webhook with timestamp skew ${skewSeconds}s (max 300s)`);
    return false;
  }
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  // Svix secret is base64 with a "whsec_" prefix
  const secretClean = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const secretBytes = Buffer.from(secretClean, "base64");
  const expected = createHmac("sha256", secretBytes).update(signedPayload).digest("base64");
  // Svix header is space-separated "v1,sig v1,sig …" — any match wins
  const sigs = svixSignatureHeader.split(" ").map((s) => s.replace(/^v1,/, ""));
  for (const s of sigs) {
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(s);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch {
      // continue trying other sigs
    }
  }
  return false;
}

// Node runtime required: email-HTML sanitization (lib/.../sanitize.ts) uses
// isomorphic-dompurify → jsdom, which cannot run on the edge runtime.
export const runtime = "nodejs";

export async function POST(request: Request) {
  // Read raw body BEFORE JSON-parsing so signature verification is byte-accurate.
  const rawBody = await request.text();
  const headers = request.headers;
  const ok = verifySignature(
    rawBody,
    headers.get("svix-id"),
    headers.get("svix-timestamp"),
    headers.get("svix-signature")
  );
  if (!ok) {
    // Stage 3.5: page Slack on signature failures. Dedup absorbs
    // legitimate retries of a stale-timestamp webhook (single source).
    // A burst of unique-sig failures = either a Resend rotation we
    // missed or an attacker probing — both worth knowing about
    // immediately.
    reportError({
      key: "resend_inbound_bad_signature",
      message: "Resend inbound webhook signature verification failed",
      platform: "shared",
      context: {
        svix_id_present: !!headers.get("svix-id"),
        svix_ts_present: !!headers.get("svix-timestamp"),
      },
    });
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let payload: ResendInboundPayload;
  try {
    payload = JSON.parse(rawBody) as ResendInboundPayload;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const data = payload.data;
  if (!data) {
    // Resend sends test pings — return 200 so the dashboard shows "verified"
    return NextResponse.json({ ok: true, ignored: "no_data" });
  }

  // Stage 2 — BCC archive routing. Run BEFORE the existing customer-
  // form/supplier-order threading + log matches. Audit fix 2026-06-18:
  // do NOT short-circuit on archive match. A real email can legitimately
  // hit BOTH surfaces (e.g. Alex forwards a supplier reply AND BCCs the
  // archive). The customer-form / supplier-order threading must still
  // run so that reply still lands in inbox_messages. Idempotency on
  // inbox_messages.resend_message_id prevents double-thread; archive
  // dedup happens via its own UNIQUE on (source_kind, source_id,
  // message_id).
  const archiveResult = await runInboundArchive(data as unknown as ArchivePayload);
  if (!archiveResult.ok && archiveResult.errors.length > 0) {
    console.warn(
      `[resend-inbound] archive errors: ${JSON.stringify(archiveResult.errors)}`
    );
  }
  if (archiveResult.skipped.length > 0) {
    // HMAC mismatch / source not found / etc — log for forensics.
    console.warn(
      `[resend-inbound] archive skipped: ${JSON.stringify(archiveResult.skipped)}`
    );
    // Stage 3.5: only page Slack on HMAC MISMATCHES (active forgery
    // attempt or address rotation we missed). source_not_found is a
    // normal "deleted opp got an email" case — not worth a Slack ping.
    const hmacMismatches = archiveResult.skipped.filter(
      (s) => s.reason === "hmac_mismatch"
    );
    if (hmacMismatches.length > 0) {
      reportWarn({
        key: "archive_hmac_mismatch",
        message: "Archive HMAC verification failed on inbound email",
        platform: "commercial_cc",
        context: {
          count: hmacMismatches.length,
          first_recipient_kind: hmacMismatches[0].recipient.split("@")[0]?.slice(0, 30),
        },
      });
    }
  }
  // Don't return early: continue into the existing customer-form /
  // supplier threading flow so an email that's BOTH a supplier reply
  // AND archived still lands in inbox_messages. The two storage paths
  // are independent on purpose.

  const parsedFrom = parseAddress(data.from);
  const fromEmail = parsedFrom.email;
  if (!fromEmail) {
    // Still possible — a malformed From really does exist — but now it means
    // what it says instead of catching every well-formed delivery.
    reportError({
      key: "resend_inbound_no_from",
      message: `Inbound webhook carried no usable From address: ${JSON.stringify(data.from ?? null).slice(0, 200)}`,
      platform: "shared",
    });
    return NextResponse.json({ ok: true, ignored: "no_from" });
  }
  const fromName = parsedFrom.name;
  const toEmail = Array.isArray(data.to) ? parseAddress(data.to[0]).email : null;
  const subject = data.subject ?? null;
  // The webhook carries metadata only, so the body and headers are pulled
  // back by id. Falls through to whatever the payload had if that fails.
  const fetched = data.text || data.html ? null : await fetchReceivedEmail(data.email_id);
  const bodyText = data.text ?? fetched?.text ?? null;
  const bodyHtml = data.html ?? fetched?.html ?? null;
  const allHeaders = data.headers ?? fetched?.headers ?? null;
  // Dedup key for inbox_messages.resend_message_id (UNIQUE). A NULL never
  // collides in a Postgres UNIQUE index, so relying on data.message_id alone
  // means any inbound email lacking a message_id inserts a fresh DUPLICATE row
  // on every webhook retry. Fall back to the Svix delivery id (stable across
  // retries of the same delivery), then to a content hash so two genuinely
  // different emails still differ. Only used for dedup — threading uses
  // in_reply_to / PO / from-email, not this column.
  const svixId = headers.get("svix-id");
  const messageId =
    data.message_id ??
    fetched?.messageId ??
    (svixId ? `svix:${svixId}` :
      `hash:${createHmac("sha256", "inbound-dedup")
        .update(`${fromEmail}|${subject ?? ""}|${data.created_at ?? ""}|${(bodyText ?? "").slice(0, 500)}`)
        .digest("hex").slice(0, 40)}`);
  // Header names are case-insensitive on the wire; Resend returns them as
  // sent, so a provider using "In-Reply-To" would otherwise miss.
  const headerLookup = (name: string): string | null => {
    if (!allHeaders) return null;
    const hit = Object.entries(allHeaders).find(([k]) => k.toLowerCase() === name);
    return hit ? String(hit[1]) : null;
  };
  const inReplyTo = data.in_reply_to ?? headerLookup("in-reply-to") ?? null;

  const sb = adminClient();

  // ── Threading: try the three priority matchers ──
  let kind: "customer_reply" | "supplier_reply" | "unmatched" = "unmatched";
  let linkedToken: string | null = null;
  let linkedOrderId: string | null = null;
  let linkedWorkOrderId: string | null = null;

  // 1. In-Reply-To header matches a known Resend message id?
  // Only matches against supplier_orders.resend_message_id today —
  // customer_form_tokens doesn't capture the invite Resend message-id yet.
  // Customer replies fall through to the email-match path below; once we
  // add a resend_message_id column to customer_form_tokens (migration TBD)
  // we can add a second .eq() lookup here.
  if (inReplyTo) {
    // Strip angle brackets that some clients add
    const replyTo = inReplyTo.replace(/[<>]/g, "").trim();
    const { data: orderRow } = await sb
      .from("supplier_orders")
      .select("id, work_order_id")
      .eq("resend_message_id", replyTo)
      .maybeSingle();
    if (orderRow) {
      kind = "supplier_reply";
      linkedOrderId = orderRow.id;
      linkedWorkOrderId = orderRow.work_order_id;
    }
  }

  // 2. PO number in subject? Match BOTH the new format (Katie 2026-06-05:
  // `PPP-WO00284666` or `PPP-WO00284666-2`) AND the legacy format with
  // supplier-code segment (`PPP-WO00284666-ABO-000123`) so supplier replies
  // on old in-flight orders still thread correctly after the format change.
  //
  // Pattern, anchored to the WO core:
  //   `PPP-WO`           literal
  //   `[A-Z0-9]+`        WO number (alphanumeric, no internal hyphens)
  //   `(?:-[A-Z]+-\d+)?` OPTIONAL legacy supplier-code + seq tail
  //   `(?:-\d+)?`        OPTIONAL new-format collision suffix (-2, -3, …)
  //
  // The two optional tails are mutually exclusive in practice (an old PO
  // always has the alpha tail; a new PO never does). Regex tries the longest
  // match first so a legacy `PPP-WO123-ABO-1` doesn't accidentally truncate
  // to `PPP-WO123`. The DB lookup is exact-match so any false alpha mass-up
  // here just falls through to "unmatched" — no wrong thread.
  if (kind === "unmatched" && subject) {
    // Legacy PPP-WO… first, then the bare number Katie moved us to on
    // 2026-09-08. Order matters: a legacy subject contains digits too, and
    // matching those first would truncate PPP-WO123-ABO-1 to "123".
    //
    // The bare pattern is anchored on "PPP Order " from our own subject line,
    // because an unanchored run of digits in a REPLY body — a phone number, an
    // invoice, a date — would match anything. The DB lookup is exact, so a
    // wrong guess simply finds no row, but a wrong guess that DOES hit another
    // order would thread a supplier's reply onto the wrong job.
    const poMatch =
      subject.match(/PPP-WO[A-Z0-9]+(?:-[A-Z]+-\d+)?(?:-\d+)?/i) ??
      subject.match(/PPP Order\s+(\d{5,}(?:-\d+)?)/i);
    if (poMatch) {
      // Group 1 when the bare-number pattern matched (its match includes the
      // "PPP Order " anchor); group 0 for the legacy pattern, which has no
      // capture. Taking [0] blindly threaded on "PPP Order 00316046" and would
      // have found no row — a silent stop to supplier-reply threading.
      const poNumber = poMatch[1] ?? poMatch[0];
      const { data: orderRow } = await sb
        .from("supplier_orders")
        .select("id, work_order_id")
        .eq("po_number", poNumber)
        .maybeSingle();
      if (orderRow) {
        kind = "supplier_reply";
        linkedOrderId = orderRow.id;
        linkedWorkOrderId = orderRow.work_order_id;
      }
    }
  }

  // 3. From-email matches a customer-form recipient? (last-resort heuristic)
  if (kind === "unmatched" && fromEmail) {
    const { data: tokenRow } = await sb
      .from("customer_form_tokens")
      .select("token, work_order_id")
      .eq("customer_email", fromEmail.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tokenRow) {
      kind = "customer_reply";
      linkedToken = tokenRow.token;
      linkedWorkOrderId = tokenRow.work_order_id;
    }
  }

  // ── Insert into inbox_messages ──
  // Audit fix 2026-06-18: when the archive already captured this email
  // (matched > 0) AND threading didn't tie it to a real supplier order or
  // customer form, skip the unmatched-bucket insert. The archive owns the
  // record; an extra unmatched row in inbox_messages is just noise that
  // pollutes the Mail Hub triage queue. Threading matches DO still insert
  // because the supplier/customer flow needs the row even when the email
  // was also archived.
  if (archiveResult.matched.length > 0 && kind === "unmatched") {
    return NextResponse.json({
      ok: true,
      routed: "commercial_archive_only",
      matched: archiveResult.matched.map((m) => ({
        kind: m.kind,
        source_id_short: m.source_id.slice(0, 8),
        archived: m.archived_id !== null,
      })),
      skipped: archiveResult.skipped,
    });
  }

  const { error: insertErr } = await sb
    .from("inbox_messages")
    .insert({
      kind,
      linked_token: linkedToken,
      linked_order_id: linkedOrderId,
      linked_work_order_id: linkedWorkOrderId,
      from_email: fromEmail.toLowerCase(),
      from_name: fromName,
      to_email: toEmail,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      resend_message_id: messageId,
      in_reply_to: inReplyTo,
      received_at: data.created_at ?? new Date().toISOString(),
      raw_payload: payload as unknown as Record<string, unknown>,
    });

  /**
   * Kate 2026-10-14 asked how the guys see vendor replies. They threaded
   * correctly and nothing announced them — the only signal was an unread
   * count visible once you were already in Mail.
   *
   * AFTER the insert, and only for a reply we actually placed against an
   * order. Deliberately not awaited into the response: this webhook must
   * return 200 once the message is stored, or Resend retries and the same
   * reply lands twice. notifySupplierReply never throws.
   */
  if (!insertErr && kind === "supplier_reply" && linkedOrderId) {
    void notifySupplierReply({
      orderId: linkedOrderId,
      workOrderId: linkedWorkOrderId,
      fromEmail: fromEmail.toLowerCase(),
      fromName,
      subject,
      bodyText,
    });
  }

  if (insertErr) {
    // UNIQUE violation on resend_message_id = duplicate ingest (Resend
    // retried the webhook). Return 200 so it stops retrying.
    if (insertErr.code === "23505") {
      return NextResponse.json({ ok: true, deduped: true });
    }
    console.error("[resend-inbound] insert failed:", insertErr);
    // Return 500 so Resend retries — likely a transient Supabase issue
    return NextResponse.json({ error: "insert_failed", message: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, kind, threaded: kind !== "unmatched" });
}

/**
 * Run the Commercial BCC archive, contained.
 *
 * Returns the same shape on failure as a run that archived nothing, so the
 * caller's residential threading proceeds untouched. Deliberately does NOT
 * rethrow: an archive that cannot load must not cost PPP a supplier reply.
 */
async function runInboundArchive(data: ArchivePayload): Promise<ArchiveResult> {
  try {
    const mod = await import("@/lib/commercial/email-archive/inbound");
    return await mod.processInboundArchive(data);
  } catch (err) {
    // Loud, because this is the failure that hid for months behind a 500.
    reportError({
      key: "resend_inbound_archive_unavailable",
      message: `Commercial email archive could not run: ${err instanceof Error ? err.message : String(err)}`,
      platform: "shared",
    });
    return { ok: false, matched: [], skipped: [], errors: [] };
  }
}
