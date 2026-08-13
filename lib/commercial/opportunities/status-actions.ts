"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { changeOpportunityStatus } from "@/lib/commercial/opportunities/status";
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from "@/lib/commercial/opportunities/constants";

/**
 * Move a deal's status in ONE click, from wherever the next-step button is.
 *
 * Karan 2026-08-13: *"when I click Move it to Estimating it should move the
 * status — it doesn't right now, it just brings me to change status. Same with
 * mark as won or lost, it should bring a popup."*
 *
 * He is right, and the distinction is what the step KNOWS. "Move it to
 * Estimating", "Start the job" and "Put it in progress" each name exactly one
 * destination — there is nothing left to ask, so sending someone to a form to
 * re-select the answer the button already contains is a wasted click and reads
 * as the button not working.
 *
 * Won vs lost is different: that is a real question, so the button offers the
 * two answers rather than moving on its own.
 *
 * A LOST move still routes to the change-status card, because a loss needs its
 * reason captured — recording losses without reasons is how the win/loss
 * report becomes decoration. Won posts its placeholder debrief note the same
 * way the pipeline quick-flip does, so both paths leave identical trails.
 */
export async function moveOpportunityStatusAction(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const oppId = String(formData.get("opp_id") ?? "");
  const toStatus = String(formData.get("to_status") ?? "");
  const toSub = String(formData.get("to_sub_status") ?? "").trim() || undefined;
  const base = `/commercial/opportunities/${oppId}`;

  if (!/^[0-9a-f-]{36}$/i.test(oppId)) redirect("/commercial/opportunities");
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(toStatus)) {
    redirect(`${base}?error=${encodeURIComponent("Invalid status.")}`);
  }

  // A loss needs its reason. Hand it to the card that captures one rather than
  // recording a bare Lost — the win/loss report is only worth having if the
  // reasons are in it.
  if (toStatus === "pre_sale_closed" && toSub === "lost") {
    redirect(`${base}?tab=info&focus=status&to=pre_sale_closed&to_sub=lost#change-status`);
  }

  const result = await changeOpportunityStatus({
    opp_id: oppId,
    to_status: toStatus as OpportunityStatus,
    to_sub_status: toSub,
    acting_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`${base}?error=${encodeURIComponent(result.error)}`);
  }

  if (toStatus === "pre_sale_closed" && toSub === "won") {
    // Same trail as the pipeline quick-flip: a placeholder note so the debrief
    // has something to hang off, then the account-scoped debrief page.
    const { postPlaceholderAutoNote } = await import("@/lib/commercial/win-loss/debrief");
    await postPlaceholderAutoNote({ opportunityId: oppId, outcome: "won", actorUserId: user.id });
    const { getCommercialOpportunity } = await import("@/lib/commercial/opportunities/db");
    const flipped = await getCommercialOpportunity(oppId);
    if (flipped) {
      redirect(`/commercial/accounts/${flipped.account_id}/debrief/${oppId}?just_closed=1`);
    }
  }

  revalidatePath(base);
  redirect(`${base}?status_ok=1`);
}
