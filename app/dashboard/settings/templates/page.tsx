import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadTemplates, DEFAULT_TEMPLATES } from "@/lib/customer-form/templates";
import TemplatesEditor from "@/components/templates-editor";
import PageHeader from "@/components/page-header";

/**
 * Admin-only editor for customer-facing copy:
 *   - The invite email (subject + intro + outro + signoff)
 *   - The form header + thank-you screen
 *
 * Code defaults live in lib/customer-form/templates.ts and apply when a
 * field is empty in the DB. Edits write to customer_form_templates and
 * take effect immediately on the NEXT email send / form render (no cache
 * invalidation needed — loadTemplates() reads fresh on every call).
 */

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/dashboard");

  const { templates, isCustomized, updatedAt } = await loadTemplates();

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Customer-Facing Copy"
        subtitle="Edit the email + form text your customers see. Changes take effect on the next send/render — no deploy needed."
      />
      <TemplatesEditor
        initial={templates}
        defaults={DEFAULT_TEMPLATES}
        isCustomized={isCustomized}
        updatedAt={updatedAt}
      />
    </div>
  );
}
