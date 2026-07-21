import { NextResponse } from "next/server";
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
  kind: "account" | "opportunity" | "invoice";
  id: string;
  label: string;
  hint: string;
  href: string;
};

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!(profile as { has_new_platform_access?: boolean } | null)?.has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const rawQ = (searchParams.get("q") ?? "").trim();
  if (rawQ.length === 0) return NextResponse.json({ results: [] });
  // Escape SQL LIKE wildcards — audit fix 2026-07-11: also escape
  // backslash because Postgres uses `\` as the default LIKE escape
  // character. Without this, a query of `\` becomes `%\%` which is a
  // syntax error at worst or matches nothing at best.
  const safe = rawQ.replace(/[\\%_]/g, "\\$&");
  const pattern = `%${safe}%`;
  // 2026-07-21: let users paste a full id chip and still match. The
  // underlying columns store the number WITHOUT the family prefix
  // (project_number "2026-0042", invoice_number "INV-0113"), so strip a
  // leading OPP-/ACC-/PROP-/INV- before matching those id columns.
  const idSafe = safe.replace(/^(opp|acc|prop|inv)-/i, "");
  const idPattern = `%${idSafe}%`;

  const [accountsRes, oppsRes, invoicesRes] = await Promise.all([
    sb
      .from("commercial_accounts")
      .select("id, company_name, city, state, account_seq")
      .is("deleted_at", null)
      .ilike("company_name", pattern)
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
      .from("commercial_invoices")
      .select("id, invoice_number, po_number, account_id, opportunity_id, total_cents, status")
      .is("deleted_at", null)
      .or(`invoice_number.ilike.${idPattern},po_number.ilike.${pattern}`)
      .order("issued_at", { ascending: false })
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
      href: `/commercial/opportunities/${o.id}`,
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

  return NextResponse.json({ results });
}
