import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import TestFormView from "@/components/test-form-view";

/**
 * Admin tool — paste a Salesforce Work Order id, get back a working
 * preview link or send a real color form to any email. Lets PPP test
 * the customer-facing flow without hunting through the materials list
 * (some test WOs don't appear there because they're missing line items
 * or in a status that's filtered out — this bypasses all of that).
 */

export const dynamic = "force-dynamic";

export default async function TestFormPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) redirect("/");
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) redirect("/dashboard");
  return <TestFormView userEmail={data.user.email ?? ""} />;
}
