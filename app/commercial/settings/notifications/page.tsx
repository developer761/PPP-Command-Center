import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  listNotificationRules,
  createNotificationRule,
  setNotificationRuleEnabled,
  deleteNotificationRule,
} from "@/lib/commercial/notification-rules/db";
import { ruleSummary, ruleChannelLabel } from "@/lib/commercial/notification-rules/constants";
import AddNotificationRuleForm from "@/components/commercial/add-notification-rule-form";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";

/**
 * Settings → Notifications (Block 3B). Built-in alerts (informational) + a
 * builder for personal custom alert rules. Rules are owner-scoped; the daily
 * cron evaluates them and notifies the owner.
 */

export const dynamic = "force-dynamic";

const BASE = "/commercial/settings/notifications";

const BUILT_IN = [
  { label: "Deal status changed", blurb: "When a teammate moves one of your deals." },
  { label: "New note / mention", blurb: "When someone adds a note or @-mentions you." },
  { label: "Task assigned / overdue", blurb: "When a task is assigned to you or slips past due." },
  { label: "Proposal sent", blurb: "When a proposal goes out to a GC on your team's deal." },
  { label: "Invoice created / paid", blurb: "Cash-flow moments across your deals." },
  { label: "Hot deal cooling · document expiring", blurb: "Daily nudges when a high-value deal or a doc needs attention." },
];

async function requireUser(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  return user.id;
}

async function createAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const res = await createNotificationRule({
    ownerUserId: userId,
    name: String(formData.get("name") ?? ""),
    trigger: String(formData.get("trigger") ?? ""),
    threshold_days: Number(formData.get("threshold_days") ?? 0),
    channel: String(formData.get("channel") ?? "both"),
  });
  revalidatePath(BASE);
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  redirect(`${BASE}?ok=created`);
}

async function toggleAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  await setNotificationRuleEnabled({
    ownerUserId: userId,
    ruleId: String(formData.get("id") ?? ""),
    enabled: String(formData.get("enabled") ?? "") === "true",
  });
  revalidatePath(BASE);
  redirect(BASE);
}

async function deleteAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  await deleteNotificationRule({ ownerUserId: userId, ruleId: String(formData.get("id") ?? "") });
  revalidatePath(BASE);
  redirect(`${BASE}?ok=deleted`);
}

export default async function CommercialNotificationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const userId = await requireUser();
  const [rules, sp] = await Promise.all([listNotificationRules(userId), searchParams]);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ppp-charcoal">Notification alerts</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">
          Built-in alerts fire automatically. Create your own custom alerts below.
          Your notifications appear in the bell and on the{" "}
          <a href="/commercial/notifications" className="text-cc-brand-700 hover:underline font-medium">Notifications</a> page.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-800 text-sm px-4 py-3">{sp.error}</div>
      )}
      {sp.ok === "created" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm px-4 py-3">Alert created — the daily check will start including it.</div>
      )}
      {sp.ok === "deleted" && (
        <div className="rounded-lg border border-ppp-charcoal-200 bg-ppp-charcoal-50 text-ppp-charcoal-700 text-sm px-4 py-3">Alert deleted.</div>
      )}

      {/* Built-in */}
      <section>
        <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-3">Built-in alerts</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {BUILT_IN.map((b) => (
            <div key={b.label} className="flex items-start gap-2.5 rounded-lg border border-ppp-charcoal-100 bg-white px-3.5 py-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-600 shrink-0 mt-0.5" aria-hidden>
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ppp-charcoal">{b.label}</div>
                <div className="text-[11.5px] text-ppp-charcoal-500 leading-snug">{b.blurb}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-ppp-charcoal-400 mt-2">These are always on and can&apos;t be turned off individually.</p>
      </section>

      {/* Custom */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400">Your custom alerts</h2>
        <AddNotificationRuleForm action={createAction} />

        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ppp-charcoal-200 px-4 py-8 text-center text-sm text-ppp-charcoal-400">
            No custom alerts yet. Create one above and it&apos;ll run with the daily check.
          </p>
        ) : (
          <ul className="bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
            {rules.map((r) => (
              <li key={r.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-ppp-charcoal truncate">{r.name}</span>
                    {!r.enabled && (
                      <span className="rounded bg-ppp-charcoal-100 px-1.5 py-0.5 text-[10px] font-semibold text-ppp-charcoal-500">Paused</span>
                    )}
                  </div>
                  <div className="text-[11.5px] text-ppp-charcoal-500 truncate mt-0.5">
                    {ruleSummary(r.trigger, r.threshold_days)}
                    <span className="mx-1.5 text-ppp-charcoal-300">·</span>
                    {ruleChannelLabel(r.channel)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <form action={toggleAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="enabled" value={r.enabled ? "false" : "true"} />
                    <PendingSubmitButton
                      className="inline-flex items-center rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-xs font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
                      pendingLabel="…"
                    >
                      {r.enabled ? "Pause" : "Resume"}
                    </PendingSubmitButton>
                  </form>
                  <form action={deleteAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <ConfirmSubmitButton
                      message={`Delete the alert "${r.name}"? You'll stop receiving it.`}
                      pendingLabel="Deleting…"
                      className="inline-flex items-center rounded-lg border border-rose-200 px-2.5 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50 min-h-[44px] touch-manipulation"
                    >
                      Delete
                    </ConfirmSubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
