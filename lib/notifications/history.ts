import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Paginated notification history for the full Notifications pages. Scoped by
 * recipient_user_id (a user only ever reads their own rows) AND platform
 * (commercial kinds are prefixed `commercial_`; residential kinds are not),
 * so the two platforms never bleed into each other.
 */

export type NotificationRow = {
  id: string;
  kind: string;
  work_order_id: string | null;
  work_order_number: string | null;
  customer_name: string | null;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

export type NotificationHistory = {
  rows: NotificationRow[];
  /** Count matching the ACTIVE filter+kind — drives pagination. */
  total: number;
  unread: number;
  /** Count created in the last 7 days (platform-scoped, ignores filters). */
  week: number;
  /** Platform-scoped count ignoring filter+kind — the "All time" KPI. */
  allTime: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

const SELECT_COLS =
  "id, kind, work_order_id, work_order_number, customer_name, title, body, link, read_at, created_at";

export async function loadNotificationHistory(input: {
  userId: string;
  platform: "commercial" | "command_center";
  page?: number;
  pageSize?: number;
  /** "unread" restricts to unread; otherwise all. */
  filter?: "all" | "unread";
  /** Optional exact kind filter. */
  kind?: string | null;
}): Promise<NotificationHistory> {
  const sb = adminClient();
  const pageSize = input.pageSize ?? 25;
  const page = Math.max(1, input.page ?? 1);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const isCommercial = input.platform === "commercial";

  // Total (respecting all filters).
  let totalQ = sb
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_user_id", input.userId);
  totalQ = isCommercial ? totalQ.like("kind", "commercial_%") : totalQ.not("kind", "like", "commercial_%");
  if (input.filter === "unread") totalQ = totalQ.is("read_at", null);
  if (input.kind) totalQ = totalQ.eq("kind", input.kind);

  // Unread count (platform-scoped, ignoring the read/unread filter).
  let unreadQ = sb
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_user_id", input.userId)
    .is("read_at", null);
  unreadQ = isCommercial ? unreadQ.like("kind", "commercial_%") : unreadQ.not("kind", "like", "commercial_%");

  // This-week count (last 7 days, platform-scoped, ignoring filters) — for the
  // at-a-glance KPI strip.
  const weekAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
  let weekQ = sb
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_user_id", input.userId)
    .gte("created_at", weekAgoIso);
  weekQ = isCommercial ? weekQ.like("kind", "commercial_%") : weekQ.not("kind", "like", "commercial_%");

  // All-time count (platform-scoped, ignoring filter + kind) — the "All time"
  // KPI must NOT track the active filter (Karan 2026-07-27 audit: it was
  // reusing the filtered `total`, so "Unread" made "All time" show the unread
  // count).
  let allTimeQ = sb
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_user_id", input.userId);
  allTimeQ = isCommercial ? allTimeQ.like("kind", "commercial_%") : allTimeQ.not("kind", "like", "commercial_%");

  // Page rows.
  let rowsQ = sb
    .from("notifications")
    .select(SELECT_COLS)
    .eq("recipient_user_id", input.userId);
  rowsQ = isCommercial ? rowsQ.like("kind", "commercial_%") : rowsQ.not("kind", "like", "commercial_%");
  if (input.filter === "unread") rowsQ = rowsQ.is("read_at", null);
  if (input.kind) rowsQ = rowsQ.eq("kind", input.kind);

  const [{ count: total }, { count: unread }, { count: week }, { count: allTime }, { data: rows }] =
    await Promise.all([
      totalQ,
      unreadQ,
      weekQ,
      allTimeQ,
      rowsQ.order("created_at", { ascending: false }).range(from, to),
    ]);

  const totalCount = total ?? 0;
  return {
    rows: (rows ?? []) as NotificationRow[],
    total: totalCount,
    unread: unread ?? 0,
    week: week ?? 0,
    allTime: allTime ?? 0,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  };
}
