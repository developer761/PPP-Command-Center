import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { paymentsConfig } from "@/lib/payments/service";

/**
 * Who may open /pay/<token> right now.
 *
 * Until PAYMENTS_PUBLIC=1 the pay pages are for signed-in admins only — the
 * whole flow can be tested end to end on the real domain without a single
 * customer being able to reach it. Flipping that switch is the go-live.
 */
export async function getSignedInAdminEmail(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return null;
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  return isAdmin ? (data.user.email ?? "admin") : null;
}

export async function canOpenPayPages(): Promise<boolean> {
  if (paymentsConfig().publicPages) return true;
  return (await getSignedInAdminEmail()) != null;
}
