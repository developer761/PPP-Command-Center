import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PageHeader from "@/components/page-header";
import CustomersIndexView from "@/components/customers-index-view";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { loadDashboardData } from "@/lib/data-source";

/**
 * Customers index — searchable list of every customer the viewer has a
 * relationship with (owns at least one WO/Opp). Admin sees all customers
 * derived from the snapshot's WO + Opp tables.
 *
 * Click-through to /dashboard/customer/[accountId] for the full history.
 *
 * Scope: workers see only customers they own; admin sees all.
 */

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CustomersIndexPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const viewer = await resolveViewer(sp);
  if (!viewer) redirect("/");

  // Load the dashboard bundle — scoped snapshot for workers, full for admin.
  // Reuse the existing data layer so we don't re-pay the SF cost.
  const bundle = await loadDashboardData(sp);

  // Derive the customer list from snapshot.workOrders + snapshot.opportunities
  // (deduped by accountId, with fallback name-key for legacy WOs that lack
  // accountId). Server-rendered list — first paint is instant since data is
  // already in the bundle.
  const customers = deriveCustomerList(bundle);

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Customers"
        subtitle="Every customer you have a relationship with at PPP. Click any name to see their full history — every work order, color form, supplier order, and reply."
      />
      <CustomersIndexView customers={customers} isAdmin={viewer.isAdmin} />
    </div>
  );
}

type CustomerListRow = {
  accountId: string | null;
  name: string;
  woCount: number;
  oppCount: number;
  totalAmount: number;
  lastActivity: string | null;
  ownerName: string | null;
};

function deriveCustomerList(bundle: Awaited<ReturnType<typeof loadDashboardData>>): CustomerListRow[] {
  if (!bundle.snapshot) return [];
  const snap = bundle.snapshot;

  // Key by accountId when present, else by name. Mirrors the deriveAccountStats
  // approach in lib/salesforce/derive.ts.
  const acctById = new Map(snap.accounts.map((a) => [a.id, a]));
  const acctByName = new Map(snap.accounts.map((a) => [a.name, a]));
  const map = new Map<string, CustomerListRow>();

  const resolveKey = (
    row: { accountId: string | null; accountName: string | null }
  ): string | null => {
    if (row.accountId) return row.accountId;
    if (row.accountName) {
      const byName = acctByName.get(row.accountName);
      return byName?.id ?? `name::${row.accountName}`;
    }
    return null;
  };

  for (const w of snap.workOrders) {
    const key = resolveKey(w);
    if (!key) continue;
    const acct = acctById.get(key);
    const existing = map.get(key) ?? {
      accountId: w.accountId,
      name: w.accountName ?? acct?.name ?? "(unknown)",
      woCount: 0,
      oppCount: 0,
      totalAmount: 0,
      lastActivity: null,
      ownerName: null,
    };
    existing.woCount += 1;
    existing.totalAmount += w.amount ?? 0;
    if (w.ownerName && !existing.ownerName) existing.ownerName = w.ownerName;
    const woDate = w.closeDate ?? w.createdDate;
    if (woDate && (!existing.lastActivity || woDate > existing.lastActivity)) {
      existing.lastActivity = woDate;
    }
    map.set(key, existing);
  }
  for (const o of snap.opportunities) {
    const key = resolveKey(o);
    if (!key) continue;
    const acct = acctById.get(key);
    const existing = map.get(key) ?? {
      accountId: o.accountId,
      name: o.accountName ?? acct?.name ?? "(unknown)",
      woCount: 0,
      oppCount: 0,
      totalAmount: 0,
      lastActivity: null,
      ownerName: null,
    };
    existing.oppCount += 1;
    const oppDate = o.lastActivityDate ?? o.closeDate ?? o.createdDate;
    if (oppDate && (!existing.lastActivity || oppDate > existing.lastActivity)) {
      existing.lastActivity = oppDate;
    }
    map.set(key, existing);
  }

  return Array.from(map.values()).sort((a, b) => {
    // Last activity desc — most recently active first
    if (a.lastActivity && b.lastActivity) return b.lastActivity.localeCompare(a.lastActivity);
    if (a.lastActivity) return -1;
    if (b.lastActivity) return 1;
    return a.name.localeCompare(b.name);
  });
}
