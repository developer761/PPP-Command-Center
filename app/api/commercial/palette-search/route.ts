import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { formatAccountNumber } from "@/lib/commercial/accounts/db";
import { formatOpportunityNumber } from "@/lib/commercial/opportunities/db";

/**
 * GET /api/commercial/palette-search?q=bob
 *
 * Powers the ⌘K command palette. Returns a combined array of jump
 * results across accounts, opportunities, and invoices ranked by
 * simple prefix+substring match. Karan 2026-07-11 (signature-moments
 * Tier 2): Alex spends a lot of time navigating between customers,
 * their deals, and their invoices — one keyboard shortcut collapses
 * every jump to a single search.
 *
 * Auth: same has_new_platform_access gate as other Commercial CC
 * endpoints. Zero-query returns empty (no autocomplete pre-fill).
 *
 * Response:
 *   { results: [{ kind, id, label, hint, href }] }
 */

const MAX_PER_KIND = 8;

type PaletteResult = {
  kind: "account" | "opportunity" | "proposal" | "invoice" | "document";
  id: string;
  label: string;
  hint: string;
  href: string;
};

/** Parse a money-looking query ("$12,500", "12500.00", "5000") → whole cents,
 *  or null. Lets Universal Search find an invoice by its exact amount. */
function parseAmountCents(q: string): number | null {
  const cleaned = q.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return Math.round(n * 100);
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if ((await apiAccessDenied(auth?.user?.id, profile))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const rawQ = (searchParams.get("q") ?? "").trim();
  if (rawQ.length === 0) return NextResponse.json({ results: [] });
  // Escape SQL LIKE wildcards — audit fix 2026-07-11: also escape
  // backslash because Postgres uses `\` as the default LIKE escape
  // character. Without this, a query of `\` becomes `%\%` which is a
  // syntax error at worst or matches nothing at best.
  // Also escape the double-quote so we can wrap the value in quotes below —
  // Karan 2026-07-27 audit: a comma/paren in the query broke the .or() grammar.
  const safe = rawQ.replace(/[\\%_"]/g, "\\$&");
  const pattern = `"%${safe}%"`;
  // 2026-07-21: let users paste a full id chip and still match. The
  // underlying columns store the number WITHOUT the family prefix
  // (project_number "2026-0042", invoice_number "INV-0113"), so strip a
  // leading OPP-/ACC-/PROP-/INV- before matching those id columns.
  const idSafe = safe.replace(/^(opp|acc|prop|inv)-/i, "");
  const idPattern = `"%${idSafe}%"`;
  // account_seq is an INTEGER, so it can't be ilike-matched. When the
  // stripped query is purely numeric (e.g. "ACC-0042" → "0042" or a bare
  // "42"), also match the exact account number so a pasted ACC-#### chip
  // resolves — otherwise the displayed ACC hint would invite a dead paste.
  const acctSeqNum = /^\d+$/.test(idSafe) ? parseInt(idSafe, 10) : null;
  const acctOr =
    acctSeqNum !== null && Number.isFinite(acctSeqNum)
      ? `company_name.ilike.${pattern},account_seq.eq.${acctSeqNum}`
      : `company_name.ilike.${pattern}`;
  // proposal_seq is INT (PROP-#### stripped to the number); match it when the
  // query is numeric, plus the cached header project name.
  const propOr =
    acctSeqNum !== null
      ? `proposal_seq.eq.${acctSeqNum},header_json->>project_name.ilike.${pattern}`
      : `header_json->>project_name.ilike.${pattern}`;
  // Invoice by exact amount ("$12,500") on top of #/PO.
  const amountCents = parseAmountCents(rawQ);
  const invoiceOr =
    `invoice_number.ilike.${idPattern},po_number.ilike.${pattern}` +
    (amountCents !== null ? `,total_cents.eq.${amountCents}` : "");

  const [accountsRes, oppsRes, proposalsRes, invoicesRes, documentsRes] = await Promise.all([
    sb
      .from("commercial_accounts")
      .select("id, company_name, city, state, account_seq")
      .is("deleted_at", null)
      .or(acctOr)
      .order("company_name")
      .limit(MAX_PER_KIND),
    sb
      .from("commercial_opportunities")
      .select("id, title, client_name, property_street, project_number, account_id, status")
      .is("deleted_at", null)
      .or(
        `title.ilike.${pattern},client_name.ilike.${pattern},property_street.ilike.${pattern},project_number.ilike.${idPattern}`
      )
      .order("updated_at", { ascending: false })
      .limit(MAX_PER_KIND),
    sb
      .from("commercial_proposals")
      .select("id, proposal_seq, revision_number, status, opportunity_id, header_json, commercial_opportunities(account_id, client_name, title)")
      .is("deleted_at", null)
      .or(propOr)
      .order("updated_at", { ascending: false })
      .limit(MAX_PER_KIND),
    sb
      .from("commercial_invoices")
      .select("id, invoice_number, po_number, account_id, opportunity_id, total_cents, status")
      .is("deleted_at", null)
      .or(invoiceOr)
      .order("issued_at", { ascending: false })
      .limit(MAX_PER_KIND),
    sb
      .from("commercial_documents")
      .select("id, file_name, category, parent_type, parent_id")
      .is("deleted_at", null)
      .ilike("file_name", `%${safe}%`)
      .order("created_at", { ascending: false })
      .limit(MAX_PER_KIND),
  ]);

  const results: PaletteResult[] = [];

  for (const a of (accountsRes.data ?? []) as {
    id: string;
    company_name: string;
    city: string | null;
    state: string | null;
    account_seq: number | null;
  }[]) {
    const hint =
      [formatAccountNumber(a.account_seq), [a.city, a.state].filter(Boolean).join(", ")]
        .filter(Boolean)
        .join(" · ") || "Account";
    results.push({
      kind: "account",
      id: a.id,
      label: a.company_name,
      hint,
      href: `/commercial/accounts/${a.id}`,
    });
  }

  for (const o of (oppsRes.data ?? []) as {
    id: string;
    title: string;
    client_name: string | null;
    property_street: string | null;
    project_number: string | null;
    account_id: string;
    status: string;
  }[]) {
    const derived =
      [o.client_name, o.property_street].filter(Boolean).join(" — ") || o.title || "(untitled)";
    const oppNo = formatOpportunityNumber(o.project_number);
    const hint = oppNo ? `${oppNo} · ${o.status}` : o.status;
    results.push({
      kind: "opportunity",
      id: o.id,
      label: derived,
      hint,
      // Land on the full opportunity drill-in (the canonical home), not the
      // bare redirect shell that bounces to the account list (2026-08 flow walk).
      href: `/commercial/accounts/${o.account_id}?tab=projects&project=${o.id}`,
    });
  }

  type OppEmbed = { account_id: string; client_name: string | null; title: string | null };
  for (const pr of (proposalsRes.data ?? []) as unknown as {
    id: string;
    proposal_seq: number | null;
    revision_number: number;
    status: string;
    opportunity_id: string;
    header_json: { project_name?: string | null } | null;
    // PostgREST embeds a to-one parent as an object at runtime, but the JS types
    // widen it to an array — accept both.
    commercial_opportunities: OppEmbed | OppEmbed[] | null;
  }[]) {
    const opp = Array.isArray(pr.commercial_opportunities)
      ? pr.commercial_opportunities[0] ?? null
      : pr.commercial_opportunities;
    const acctId = opp?.account_id;
    if (!acctId) continue; // can't build a link without the account
    const propNo = pr.proposal_seq != null ? `PROP-${String(pr.proposal_seq).padStart(4, "0")}` : null;
    const label =
      pr.header_json?.project_name?.trim() ||
      [opp?.client_name, opp?.title].filter(Boolean).join(" — ") ||
      propNo ||
      "Proposal";
    results.push({
      kind: "proposal",
      id: pr.id,
      label,
      hint: [propNo, `R${pr.revision_number}`, pr.status].filter(Boolean).join(" · "),
      href: `/commercial/accounts/${acctId}/deals/${pr.opportunity_id}/proposal/${pr.id}?back=/commercial/proposals`,
    });
  }

  for (const i of (invoicesRes.data ?? []) as {
    id: string;
    invoice_number: string;
    po_number: string | null;
    total_cents: number;
    status: string;
  }[]) {
    const hint = [
      i.po_number ? `PO ${i.po_number}` : null,
      `$${(i.total_cents / 100).toFixed(2)}`,
      i.status,
    ]
      .filter(Boolean)
      .join(" · ");
    results.push({
      kind: "invoice",
      id: i.id,
      label: i.invoice_number,
      hint,
      href: `/commercial/invoices/${i.id}`,
    });
  }

  for (const d of (documentsRes.data ?? []) as {
    id: string;
    file_name: string;
    category: string | null;
    parent_type: string;
  }[]) {
    results.push({
      kind: "document",
      id: d.id,
      label: d.file_name,
      hint: [d.category ? String(d.category).replace(/_/g, " ") : null, "document"].filter(Boolean).join(" · "),
      // Documents open the file directly (new tab, handled by the palette).
      href: `/api/commercial/documents/${d.id}/download`,
    });
  }

  return NextResponse.json({ results });
}
