import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Clear the bells that point at something that no longer exists.
 *
 * Deleting a deal or a GC cascades its invoices, purchases and Field Ops jobs —
 * but never its notifications. So the bell kept unread items whose only action
 * was to open a record that had been deleted: 77 of the 191 Commercial
 * notifications on this platform led nowhere, 29 of them unread and counting
 * toward the badge.
 *
 * That is worse than clutter. An unread count is a promise that there is
 * something to do, and a queue where two in five items are dead ends is a queue
 * people stop opening — which is exactly what a notification system cannot
 * afford.
 *
 * Marked READ rather than deleted. The notification is a true record of
 * something that happened, it is just no longer actionable; history stays,
 * the badge doesn't.
 *
 * Matches on `link`, because that is the field that actually determines where
 * the notification takes you — the source-id column is per-kind and does not
 * cover the deal/account ids that appear in a proposal deep-link.
 */
export async function retireNotificationsFor(
  recordId: string
): Promise<{ retired: number }> {
  if (!recordId) return { retired: 0 };
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return { retired: 0 };
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await sb
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .like("link", `%${recordId}%`)
      .is("read_at", null)
      .select("id");
    if (error) {
      console.warn(`[notifications] could not retire bells for ${recordId}: ${error.message}`);
      return { retired: 0 };
    }
    return { retired: (data ?? []).length };
  } catch (err) {
    // Best-effort by design: tidying a bell must never fail a delete that has
    // already happened.
    console.warn(
      "[notifications] retire threw:",
      err instanceof Error ? err.message : err
    );
    return { retired: 0 };
  }
}
