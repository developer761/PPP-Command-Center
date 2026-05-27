import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import PageHeader from "@/components/page-header";
import SupplierTemplatesEditor from "@/components/supplier-templates-editor";

/**
 * Admin-only editor for per-supplier order-email templates. Sibling to
 * /dashboard/settings/templates (customer-facing copy) but scoped per
 * supplier so BM, SW, Romeo's, etc. can each have a tailored greeting +
 * intro + signoff. NULL columns in supplier_email_templates fall back to
 * the code default in lib/supplier-order/templates.ts so the system
 * always sends valid emails.
 *
 * Edits take effect immediately on the next supplier-order send (the
 * builder calls loadSupplierTemplate fresh per send).
 */

export const dynamic = "force-dynamic";

export default async function SupplierTemplatesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/dashboard");

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Supplier Email Templates"
        subtitle="Per-supplier overrides for the order email — subject, greeting, intro, outro, signoff. Empty fields fall back to the shared default."
      />
      <SupplierTemplatesEditor />
    </div>
  );
}
