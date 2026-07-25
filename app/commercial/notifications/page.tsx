import Link from "next/link";
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

  // Clamp an out-of-range page to the last real page so a stale/hand-edited
  // ?page= never shows a false-empty inbox.
  if (page > history.totalPages) {
    const p = new URLSearchParams();
    if (filter !== "all") p.set("filter", filter);
    if (kind) p.set("kind", kind);
    if (history.totalPages > 1) p.set("page", String(history.totalPages));
    const qs = p.toString();
    redirect(qs ? `/commercial/notifications?${qs}` : "/commercial/notifications");
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ppp-charcoal">Notifications</h1>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1">
            Everything that&apos;s happened across your commercial deals, proposals, and invoices.
          </p>
        </div>
        <Link
          href="/commercial/settings/notifications"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2 text-xs font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Manage alerts
        </Link>
      </div>
      <NotificationsView
        key={`${history.page}-${filter}-${kind ?? ""}`}
        rows={history.rows}
        total={history.total}
        unread={history.unread}
        week={history.week}
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
