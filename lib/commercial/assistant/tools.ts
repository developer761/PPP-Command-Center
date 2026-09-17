import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { formatCentsFull } from "@/lib/commercial/invoices/format";

/**
 * What the assistant is allowed to look up.
 *
 * READ ONLY, deliberately and permanently. It answers questions and points at
 * pages; it does not record payments, move statuses or send anything. Every
 * action on this platform has a form behind it with its own checks, and a
 * chat box that can spend money is a chat box nobody should trust.
 *
 * The model may only report figures these functions return. It is told that in
 * the system prompt, and the reason is simple: a number it works out itself is
 * indistinguishable, on screen, from one the database gave it — and one of them
 * is worth acting on.
 *
 * Each tool returns plain text, not JSON. It is what the model reads, and prose
 * with the units and the caveats already attached ("$1,369,044.37 across 35
 * open items") survives being quoted back far better than a bag of fields.
 */

const money = formatCentsFull;

/** The columns `derivedOppName` reads, as PostgREST hands them back. */
type NameCols = {
  title: string | null;
  client_name: string | null;
  title_override: string | null;
  title_override_mode: string | null;
  property_street: string | null;
};
const nameOf = (o: NameCols, account: string | null): string =>
  derivedOppName({ ...o, title: o.title ?? "" }, account);

/** Anything named like the query — jobs, GCs, invoices. */
export async function findRecords(query: string): Promise<string> {
  const q = query.trim();
  if (q.length < 2) return "Give me at least two characters to search for.";
  const sb = commercialDb();
  const like = `%${q}%`;

  const [opps, accounts, invoices] = await Promise.all([
    sb
      .from("commercial_opportunities")
      .select("id, title, status, sub_status, account_id, client_name, title_override, title_override_mode, property_street")
      .ilike("title", like)
      .is("deleted_at", null)
      .limit(12)
      .then((r) => r.data ?? []),
    sb
      .from("commercial_accounts")
      .select("id, company_name")
      .ilike("company_name", like)
      .is("deleted_at", null)
      .limit(8)
      .then((r) => r.data ?? []),
    sb
      .from("commercial_invoices")
      .select("id, invoice_number, total_cents, paid_cents, balance_cents, status")
      .ilike("invoice_number", like)
      .is("deleted_at", null)
      .limit(8)
      .then((r) => r.data ?? []),
  ]);

  const lines: string[] = [];
  for (const o of opps as Record<string, unknown>[]) {
    lines.push(
      `JOB: ${nameOf(o as unknown as NameCols, null)} — ${o.status}/${o.sub_status} — /commercial/opportunities/${o.id}`
    );
  }
  for (const a of accounts as { id: string; company_name: string }[]) {
    lines.push(`GC: ${a.company_name} — /commercial/accounts/${a.id}`);
  }
  for (const i of invoices as Record<string, unknown>[]) {
    lines.push(
      `INVOICE ${i.invoice_number}: ${money(Number(i.total_cents))} total, ${money(Number(i.paid_cents))} paid, ${money(Number(i.balance_cents))} outstanding (${i.status}) — /commercial/invoices/${i.id}`
    );
  }
  return lines.length ? lines.join("\n") : `Nothing matches "${q}".`;
}

/** One job: the money on it, end to end. */
export async function jobSummary(query: string): Promise<string> {
  const sb = commercialDb();
  const { data: hits } = await sb
    .from("commercial_opportunities")
    .select("id, title, status, sub_status, account_id, accepted_contract_cents, client_name, title_override, title_override_mode, property_street")
    .ilike("title", `%${query.trim()}%`)
    .is("deleted_at", null)
    .limit(4);
  const rows = (hits ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return `No job matches "${query}".`;
  if (rows.length > 1) {
    return `More than one job matches "${query}" — ask which:\n${rows
      .map((o) => `- ${nameOf(o as unknown as NameCols, null)}`)
      .join("\n")}`;
  }

  const o = rows[0];
  const oppId = o.id as string;
  const [invoices, purchases, account] = await Promise.all([
    paginateAll<{ total_cents: number; paid_cents: number; balance_cents: number }>(() =>
      sb.from("commercial_invoices").select("total_cents, paid_cents, balance_cents").eq("opportunity_id", oppId).is("deleted_at", null).order("id")
    ),
    paginateAll<{ category: string; amount_cents: number }>(() =>
      sb.from("commercial_project_purchases").select("category, amount_cents").eq("opportunity_id", oppId).is("deleted_at", null).order("id")
    ),
    sb.from("commercial_accounts").select("company_name").eq("id", o.account_id as string).maybeSingle().then((r) => r.data),
  ]);

  const billed = invoices.reduce((n, i) => n + Number(i.total_cents), 0);
  const paid = invoices.reduce((n, i) => n + Number(i.paid_cents), 0);
  const owed = invoices.reduce((n, i) => n + Number(i.balance_cents), 0);
  const cost = purchases.reduce((n, p) => n + Number(p.amount_cents), 0);
  const byCat = new Map<string, number>();
  for (const p of purchases) byCat.set(p.category, (byCat.get(p.category) ?? 0) + Number(p.amount_cents));

  const name = nameOf(o as unknown as NameCols, (account as { company_name?: string } | null)?.company_name ?? null);
  return [
    `${name}`,
    `GC: ${(account as { company_name?: string } | null)?.company_name ?? "—"}`,
    `Stage: ${o.status}/${o.sub_status}`,
    `Contract: ${money(Number(o.accepted_contract_cents ?? 0))}`,
    `Billed: ${money(billed)} · Collected: ${money(paid)} · Outstanding: ${money(owed)}`,
    `Cost so far: ${money(cost)} (${[...byCat.entries()].map(([c, v]) => `${c} ${money(v)}`).join(", ") || "none logged"})`,
    `Link: /commercial/opportunities/${oppId}`,
  ].join("\n");
}

/** The whole book, as the money band shows it. */
export async function moneyOverview(): Promise<string> {
  const sb = commercialDb();
  const [invoices, purchases, payments] = await Promise.all([
    paginateAll<{ total_cents: number; paid_cents: number; balance_cents: number; due_at: string | null; status: string }>(() =>
      sb.from("commercial_invoices").select("total_cents, paid_cents, balance_cents, due_at, status").is("deleted_at", null).order("id")
    ),
    paginateAll<{ category: string; amount_cents: number }>(() =>
      sb.from("commercial_project_purchases").select("category, amount_cents").is("deleted_at", null).order("id")
    ),
    paginateAll<{ amount_cents: number }>(() => sb.from("commercial_invoice_payments").select("amount_cents").order("id")),
  ]);

  const open = invoices.filter((i) => Number(i.balance_cents) > 0);
  const owed = open.reduce((n, i) => n + Number(i.balance_cents), 0);
  const collected = payments.reduce((n, p) => n + Number(p.amount_cents), 0);
  const today = new Date().toISOString().slice(0, 10);
  const late = open.filter((i) => i.due_at && String(i.due_at).slice(0, 10) < today);
  const byCat = new Map<string, number>();
  for (const p of purchases) byCat.set(p.category, (byCat.get(p.category) ?? 0) + Number(p.amount_cents));

  return [
    `Outstanding: ${money(owed)} across ${open.length} open items.`,
    `Past due: ${money(late.reduce((n, i) => n + Number(i.balance_cents), 0))} across ${late.length}.`,
    `Collected all time: ${money(collected)} over ${payments.length} payments.`,
    `Costs: ${[...byCat.entries()].map(([c, v]) => `${c} ${money(v)}`).join(", ")}.`,
    `Pages: /commercial/accounting?view=receivables and /commercial/accounting?view=aging`,
  ].join("\n");
}

/** What has been bought, and from whom. */
export async function vendorSpend(vendor?: string): Promise<string> {
  const sb = commercialDb();
  const rows = await paginateAll<{ vendor: string | null; category: string; amount_cents: number }>(() =>
    sb.from("commercial_project_purchases").select("vendor, category, amount_cents").is("deleted_at", null).order("id")
  );
  const wanted = vendor?.trim().toLowerCase();
  const scoped = wanted ? rows.filter((r) => (r.vendor ?? "").toLowerCase().includes(wanted)) : rows;
  if (scoped.length === 0) return wanted ? `Nothing bought from anything matching "${vendor}".` : "No purchases recorded.";

  const by = new Map<string, number>();
  for (const r of scoped) by.set((r.vendor ?? "—").trim() || "—", (by.get((r.vendor ?? "—").trim() || "—") ?? 0) + Number(r.amount_cents));
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const total = scoped.reduce((n, r) => n + Number(r.amount_cents), 0);
  return [
    `${money(total)} across ${scoped.length} purchases${wanted ? ` matching "${vendor}"` : ""}.`,
    ...top.map(([n, v]) => `- ${n}: ${money(v)}`),
    `Page: /commercial/accounting?view=purchases`,
  ].join("\n");
}

/** Hours on site, by crew. */
export async function crewHours(): Promise<string> {
  const sb = commercialDb();
  const [entries, employees] = await Promise.all([
    paginateAll<{ employee_id: string; actual_hours: number }>(() =>
      sb.from("commercial_time_entries").select("employee_id, actual_hours").order("id")
    ),
    paginateAll<{ id: string; display_name: string | null }>(() =>
      sb.from("commercial_employees").select("id, display_name").order("id")
    ),
  ]);
  const nameOf = new Map(employees.map((e) => [e.id, e.display_name ?? "Crew"]));
  const by = new Map<string, number>();
  for (const e of entries) {
    const n = nameOf.get(e.employee_id) ?? "Crew";
    by.set(n, (by.get(n) ?? 0) + Number(e.actual_hours));
  }
  const total = entries.reduce((n, e) => n + Number(e.actual_hours), 0);
  return [
    `${Math.round(total).toLocaleString()} hours recorded across ${by.size} crews.`,
    ...[...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, h]) => `- ${n}: ${Math.round(h).toLocaleString()}h`),
    `Hours are a record of who was on site. What the crews COST is on each job's Subcontract lines, so the two are never added together.`,
    `Page: /commercial/reports/attendance`,
  ].join("\n");
}

/** What is out for bid, and what it is worth. */
export async function openBids(): Promise<string> {
  const sb = commercialDb();
  const rows = await paginateAll<{
    id: string;
    title: string | null;
    client_name: string | null;
    title_override: string | null;
    title_override_mode: string | null;
    property_street: string | null;
    status: string;
    sub_status: string | null;
    bid_value_low_cents: number | null;
    account_id: string;
  }>(() =>
    sb
      .from("commercial_opportunities")
      .select("id, title, client_name, title_override, title_override_mode, property_street, status, sub_status, bid_value_low_cents, account_id")
      .in("status", ["proposal", "estimating", "qualifying"])
      .is("deleted_at", null)
      .order("id")
  );
  if (rows.length === 0) return "Nothing is out for bid.";
  const { data: accounts } = await sb.from("commercial_accounts").select("id, company_name");
  const acct = new Map(((accounts ?? []) as { id: string; company_name: string | null }[]).map((a) => [a.id, a.company_name]));
  const total = rows.reduce((n, r) => n + Number(r.bid_value_low_cents ?? 0), 0);
  const top = [...rows]
    .sort((a, b) => Number(b.bid_value_low_cents ?? 0) - Number(a.bid_value_low_cents ?? 0))
    .slice(0, 10);
  return [
    `${rows.length} open bids worth ${money(total)}.`,
    ...top.map(
      (r) => `- ${nameOf(r as unknown as NameCols, acct.get(r.account_id) ?? null)}: ${money(Number(r.bid_value_low_cents ?? 0))} (${r.sub_status})`
    ),
    `Page: /commercial/reports/pipeline`,
  ].join("\n");
}

/** The AR sheet — what is certified and waiting to be paid. */
export async function arSheet(): Promise<string> {
  const { getArSheetRows } = await import("@/lib/commercial/reports/tomco/ar-applications");
  const rows = await getArSheetRows();
  if (rows.length === 0) return "Nothing on the AR sheet.";
  const total = rows.reduce((n, r) => n + r.openCents, 0);
  const retention = rows.filter((r) => r.isRetention).reduce((n, r) => n + r.openCents, 0);
  const top = [...rows].sort((a, b) => b.openCents - a.openCents).slice(0, 10);
  return [
    `${money(total)} on the AR sheet across ${rows.length} lines, of which ${money(retention)} is retention.`,
    ...top.map((r) => `- ${r.jobName}: ${money(r.openCents)} — ${r.notes ?? r.label}`),
    `Page: /commercial/accounting?view=ar`,
  ].join("\n");
}
