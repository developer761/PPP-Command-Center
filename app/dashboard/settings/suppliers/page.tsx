import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import PageHeader from "@/components/page-header";
import SupplierSettingsEditor from "@/components/supplier-settings-editor";

/**
 * Admin-only page for managing per-supplier config:
 *   - Order email (where outbound orders are sent)
 *   - PPP's account number with each supplier
 *   - Pickup branch locations (rendered as dropdown when worker picks "Pickup"
 *     on the Supplier Order Modal)
 *   - is_active toggle (hides retired suppliers from the order modal)
 *
 * Awaits Katie's email + account-number values. Until set, the supplier
 * order modal disables the Send button with a hint pointing back here;
 * Copy-to-Clipboard still works so PPP isn't blocked.
 */

export const dynamic = "force-dynamic";

export default async function SupplierSettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/dashboard");

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Supplier Settings"
        subtitle="Configure how PPP orders materials from each paint supplier. Required before the Send button activates on Supplier Order Modal."
      />
      <SupplierSettingsEditor />
    </div>
  );
}
