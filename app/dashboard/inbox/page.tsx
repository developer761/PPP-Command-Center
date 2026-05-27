import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import PageHeader from "@/components/page-header";
import InboxView from "@/components/inbox-view";

/**
 * Command Center inbox — supplier replies + customer follow-ups land
 * here via the Resend inbound webhook. Replaces Gmail as the canonical
 * place for PPP staff to handle these threads.
 *
 * Per Karan's directive: all replies must flow into the dashboard, not
 * Gmail.
 *
 * Admin-only — workers don't typically need access; if that changes
 * later we can scope per-rep via linked_work_order_id.
 */

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/dashboard");

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Mail"
        subtitle="Every email the Command Center has sent or received — flip between Inbox (supplier replies + customer follow-ups) and Sent (color forms + supplier orders) for a complete record."
      />
      <InboxView />
    </div>
  );
}
