import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PageHeader from "@/components/page-header";
import CustomerHistoryView from "@/components/customer-history-view";

/**
 * Per-customer history — full account view aggregating every WO, every
 * Opp, every form/order/reply tied to this account across time.
 *
 * Scope rules enforced server-side in /api/admin/customer/[id]:
 *   - Admin (scope='all'): everything
 *   - Worker (scope='my'): only WOs + mail they own at this account
 *
 * Entry points: clickable customer name on /dashboard/materials WO detail,
 * direct URL, future sidebar "Customers" list.
 */

export const dynamic = "force-dynamic";

export default async function CustomerHistoryPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;

  // Cheap shape validation here so we 404 fast on garbage URLs without
  // hitting auth/API. SF Account ids start with 001 + 15-18 chars.
  if (!/^001[A-Za-z0-9]{12,15}$/.test(accountId)) {
    notFound();
  }

  // Auth gate at the page level — actual scope filtering happens in the
  // /api/admin/customer endpoint. We just need the user to be signed in.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Customer history"
        subtitle="Every work order, color form, supplier order, and reply tied to this customer — across all their projects with PPP."
      />
      <CustomerHistoryView accountId={accountId} />
    </div>
  );
}
