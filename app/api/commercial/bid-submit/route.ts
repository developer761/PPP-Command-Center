import { NextResponse } from "next/server";
import { commercialDb } from "@/lib/commercial/db";
import { createCommercialAccount } from "@/lib/commercial/accounts/mutations";
import { createCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { insertCommercialBidSubmittedNotifications } from "@/lib/notifications/commercial-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/commercial/bid-submit — PUBLIC (no auth). Receives a GC's bid
 * request from the /c/bid-submit form → finds-or-creates the account →
 * creates a "web" opportunity → notifies the team.
 *
 * Bot defenses: a honeypot field + Cloudflare Turnstile (verified only when
 * TURNSTILE_SECRET_KEY is set — degrades gracefully to honeypot-only) + a soft
 * per-IP in-memory rate limit. No data is ever read back out through this route.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cap = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

// Soft, best-effort per-IP limiter (per serverless instance — Turnstile is the
// real guard). 5 submissions / 10 min / IP.
const HITS = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const win = 10 * 60_000;
  const arr = (HITS.get(ip) ?? []).filter((t) => now - t < win);
  arr.push(now);
  HITS.set(ip, arr);
  return arr.length > 5;
}

async function turnstileOk(token: string, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured → skip (honeypot still applies)
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Honeypot — bots fill hidden fields. Silently accept (don't create) so they
  // don't learn it's rejected.
  if (cap(body.company_url, 200)) return NextResponse.json({ ok: true });

  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests — please try again in a few minutes." }, { status: 429 });
  }

  if (!(await turnstileOk(cap(body.turnstile_token, 4000), ip))) {
    return NextResponse.json({ error: "Verification failed — please try the check again." }, { status: 400 });
  }

  const company = cap(body.company, 200);
  const contactName = cap(body.contact_name, 200);
  const email = cap(body.email, 200).toLowerCase();
  const phone = cap(body.phone, 60);
  const projectTitle = cap(body.project_title, 200);
  const city = cap(body.city, 120);
  const state = cap(body.state, 60);
  const street = cap(body.street, 200);
  const details = cap(body.details, 4000);
  const bidDue = /^\d{4}-\d{2}-\d{2}$/.test(cap(body.bid_due_date, 10)) ? cap(body.bid_due_date, 10) : null;

  if (!company) return NextResponse.json({ error: "Please enter your company name." }, { status: 400 });
  if (!contactName) return NextResponse.json({ error: "Please enter your name." }, { status: 400 });
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Please enter a valid email so we can reply." }, { status: 400 });

  // Find-or-create the account by an exact (case-insensitive) company name so we
  // don't spawn duplicate GCs for a repeat submitter.
  const sb = commercialDb();
  // Escape LIKE wildcards in the untrusted company name — otherwise a submitter
  // sending "%" or "Turner%" would match an arbitrary existing account and attach
  // their bid to it (this is a public, unauthenticated route).
  const companyLike = company.replace(/[\\%_]/g, "\\$&");
  const { data: existing } = await sb
    .from("commercial_accounts")
    .select("id, company_name")
    .is("deleted_at", null)
    .ilike("company_name", companyLike)
    .limit(1)
    .maybeSingle();

  let accountId: string;
  let accountName = company;
  if (existing?.id) {
    accountId = (existing as { id: string }).id;
    accountName = (existing as { company_name?: string | null }).company_name ?? company;
  } else {
    const created = await createCommercialAccount({
      company_name: company,
      phone: phone || null,
      notes: `Created from a website bid request${email ? ` · contact ${email}` : ""}.`,
      created_by_user_id: null,
    });
    if (!created.ok) return NextResponse.json({ error: "Something went wrong — please try again." }, { status: 500 });
    accountId = created.account.id;
  }

  const title = projectTitle || `Bid request — ${company}`;
  const descriptionParts = [
    "Submitted via the website bid form.",
    `Contact: ${contactName}${email ? ` · ${email}` : ""}${phone ? ` · ${phone}` : ""}`,
    details ? `\nDetails:\n${details}` : "",
  ].filter(Boolean);

  const nowIso = new Date().toISOString();
  const opp = await createCommercialOpportunity({
    account_id: accountId,
    title,
    description: descriptionParts.join("\n"),
    source: "web",
    client_name: contactName || null,
    property_street: street || null,
    property_city: city || null,
    property_state: state || null,
    proposal_due_at: bidDue,
    rfp_received_at: nowIso,
    created_by_user_id: null,
  });
  if (!opp.ok) return NextResponse.json({ error: "Something went wrong — please try again." }, { status: 500 });

  // Notify the team (best-effort — never fail the submission on a notify error).
  try {
    await insertCommercialBidSubmittedNotifications({
      opportunityId: opp.opportunity.id,
      accountId,
      accountName,
      contactName,
      contactEmail: email,
      oppTitle: title,
    });
  } catch (err) {
    console.warn("[bid-submit] team notify failed:", err);
  }

  return NextResponse.json({ ok: true });
}
