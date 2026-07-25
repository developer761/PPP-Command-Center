import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { loadNotificationHistory } from "@/lib/notifications/history";
import { notificationKindsForPlatform } from "@/lib/notifications/labels";
import PageHeader from "@/components/page-header";
import NotificationsView from "@/components/notifications-view";

/**
 * Full Command Center notifications inbox — the bell only shows the most
 * recent few, so this is the paginated history. Scoped to residential kinds
 * (everything NOT prefixed `commercial_`); access is gated by the dashboard
 * layout.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ page?: string; filter?: string; kind?: string }>;

export default async function DashboardNotificationsPage({ searchParams }: { searchParams: SP }) {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const filter = sp.filter === "unread" ? "unread" : "all";
  const kind = sp.kind || null;

  const history = await loadNotificationHistory({
    userId: user.id,
    platform: "command_center",
    page,
    filter,
    kind,
  });

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Notifications"
        subtitle="Your full notification history — color-form submissions and team updates."
      />
      <NotificationsView
        rows={history.rows}
        total={history.total}
        unread={history.unread}
        page={history.page}
        totalPages={history.totalPages}
        filter={filter}
        kind={kind}
        platform="command_center"
        basePath="/dashboard/notifications"
        kindOptions={notificationKindsForPlatform("command_center")}
      />
    </div>
  );
}
