import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadNotificationHistory } from "@/lib/notifications/history";
import { notificationKindsForPlatform } from "@/lib/notifications/labels";
import NotificationsView from "@/components/notifications-view";

/**
 * Full Commercial notifications inbox — the bell only shows the most recent
 * few, so this is the paginated history. Scoped to `commercial_%` kinds only
 * (platform access is enforced by the commercial layout).
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ page?: string; filter?: string; kind?: string }>;

export default async function CommercialNotificationsPage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const filter = sp.filter === "unread" ? "unread" : "all";
  const kind = sp.kind || null;

  const history = await loadNotificationHistory({
    userId: user.id,
    platform: "commercial",
    page,
    filter,
    kind,
  });

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ppp-charcoal">Notifications</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">
          Everything that&apos;s happened across your commercial deals, proposals, and invoices.
        </p>
      </div>
      <NotificationsView
        rows={history.rows}
        total={history.total}
        unread={history.unread}
        page={history.page}
        totalPages={history.totalPages}
        filter={filter}
        kind={kind}
        platform="commercial"
        basePath="/commercial/notifications"
        kindOptions={notificationKindsForPlatform("commercial")}
      />
    </div>
  );
}
