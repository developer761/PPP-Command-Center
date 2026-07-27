"use client";

import { useState } from "react";
import {
  TRIGGER_META,
  TRIGGER_GROUPS,
  RULE_CHANNELS,
  type RuleTrigger,
  type RuleChannel,
} from "@/lib/commercial/notification-rules/constants";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";

/** Short labels for the segmented channel control. */
const CHANNEL_SHORT: Record<RuleChannel, string> = {
  both: "In-app + email",
  bell: "In-app",
  email: "Email",
};

/**
 * Add-rule form (Block 3B). Custom card/segmented pickers — no native <select>
 * (Karan dislikes the gray dropdowns). The "N days" field shows only for
 * threshold triggers; the typed value is preserved per-trigger so switching
 * back and forth never silently loses it. Submits to a server action.
 */

/** Per-trigger icon for the picker cards. */
function TriggerIcon({ trigger }: { trigger: RuleTrigger }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (trigger) {
    case "invoice_overdue":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "invoice_due_soon":
      return <svg {...common}><path d="M8 2v4M16 2v4M3 10h18" /><rect x="3" y="4" width="18" height="18" rx="2" /></svg>;
    case "invoice_paid":
      return <svg {...common}><path d="M20 6 9 17l-5-5" /></svg>;
    case "proposal_idle":
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
    case "followup_due":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></svg>;
    case "opp_no_activity":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
    case "deal_won":
      return <svg {...common}><path d="M6 9H4a2 2 0 0 1 0-4h2M18 9h2a2 2 0 0 0 0-4h-2M6 5h12v4a6 6 0 0 1-12 0zM12 15v3M9 21h6" /></svg>;
    case "deal_lost":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></svg>;
    default:
      return <svg {...common}><circle cx="12" cy="12" r="9" /></svg>;
  }
}

export default function AddNotificationRuleForm({
  action,
}: {
  action: (formData: FormData) => void;
}) {
  const [trigger, setTrigger] = useState<RuleTrigger>("invoice_overdue");
  const [channel, setChannel] = useState<RuleChannel>("both");
  // Preserve the day value PER trigger so switching away and back keeps it.
  const [daysByTrigger, setDaysByTrigger] = useState<Partial<Record<RuleTrigger, number>>>({});

  const meta = TRIGGER_META[trigger];
  const days = daysByTrigger[trigger] ?? meta.defaultDays;
  const setDays = (n: number) =>
    setDaysByTrigger((prev) => ({ ...prev, [trigger]: Math.max(0, Math.min(365, n)) }));

  return (
    <form
      action={action}
      className="rounded-xl border border-ppp-charcoal-100 bg-white p-4 sm:p-5 space-y-5"
    >
      <input type="hidden" name="trigger" value={trigger} />
      <input type="hidden" name="channel" value={channel} />

      <div className="flex items-center gap-2.5">
        <span className="flex items-center justify-center h-9 w-9 rounded-lg bg-cc-brand-50 text-cc-brand-700 shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0 M18 2l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
          </svg>
        </span>
        <div>
          <h3 className="text-base font-semibold text-ppp-charcoal">Create a custom alert</h3>
          <p className="text-xs text-ppp-charcoal-500">Choose what to watch for and how you want to hear about it.</p>
        </div>
      </div>

      {/* Name */}
      <label className="block">
        <span className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
          Name <span className="text-rose-500">*</span>
        </span>
        <input
          type="text"
          name="name"
          required
          maxLength={80}
          placeholder="e.g. Chase invoices 15 days past due"
          className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 min-h-[44px]"
        />
      </label>

      {/* Trigger — card picker (no native select) */}
      <fieldset>
        <legend className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-2">Alert me when…</legend>
        <div className="space-y-3">
          {TRIGGER_GROUPS.map((group) => (
            <div key={group.heading}>
              <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1.5">{group.heading}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {group.triggers.map((t) => {
                  const active = trigger === t;
                  const m = TRIGGER_META[t];
                  return (
                    <button
                      type="button"
                      key={t}
                      onClick={() => setTrigger(t)}
                      aria-pressed={active}
                      className={`flex items-start gap-2.5 text-left rounded-xl border px-3 py-2.5 min-h-[44px] transition-colors touch-manipulation ${
                        active
                          ? "border-cc-brand-500 bg-cc-brand-50 ring-1 ring-cc-brand-500"
                          : "border-ppp-charcoal-200 bg-white hover:bg-ppp-charcoal-50"
                      }`}
                    >
                      <span className={`mt-0.5 shrink-0 ${active ? "text-cc-brand-700" : "text-ppp-charcoal-400"}`}>
                        <TriggerIcon trigger={t} />
                      </span>
                      <span className="min-w-0">
                        <span className={`block text-[13px] font-semibold ${active ? "text-cc-brand-800" : "text-ppp-charcoal-800"}`}>{m.label}</span>
                        <span className="block text-[11px] text-ppp-charcoal-500 leading-snug">{m.blurb}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {/* Threshold — only for triggers that use it. Hidden input always present
          so the server gets a value (0 for event triggers). */}
      {meta.usesThreshold ? (
        <label className="block max-w-[260px]">
          <span className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">Number of days</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              name="threshold_days"
              min={0}
              max={365}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) || 0)}
              inputMode="numeric"
              className="w-24 px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px] tabular-nums"
            />
            <span className="text-[13px] text-ppp-charcoal-500">{meta.thresholdNoun}</span>
          </div>
        </label>
      ) : (
        <input type="hidden" name="threshold_days" value={0} />
      )}

      {/* Channel — segmented control (no native select) */}
      <div>
        <span className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">How to notify me</span>
        <div className="inline-flex rounded-xl border border-ppp-charcoal-200 bg-ppp-charcoal-50 p-1 gap-1 w-full sm:w-auto">
          {RULE_CHANNELS.map((c) => {
            const active = channel === c;
            return (
              <button
                type="button"
                key={c}
                onClick={() => setChannel(c)}
                aria-pressed={active}
                className={`flex-1 sm:flex-none inline-flex items-center justify-center rounded-lg px-3.5 min-h-[40px] text-[13px] font-semibold transition-colors touch-manipulation ${
                  active ? "bg-white text-cc-brand-700 shadow-sm" : "text-ppp-charcoal-500 hover:text-ppp-charcoal-700"
                }`}
              >
                {CHANNEL_SHORT[c]}
              </button>
            );
          })}
        </div>
        <span className="block mt-2 text-[11px] text-ppp-charcoal-400">
          Email requires turning on email notifications above.
        </span>
      </div>

      <div className="flex justify-end pt-1">
        <PendingSubmitButton
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-cc-brand-600 px-5 text-sm font-semibold text-white hover:bg-cc-brand-700 active:bg-cc-brand-700 transition-colors min-h-[44px] touch-manipulation"
          pendingLabel="Creating…"
        >
          Create alert
        </PendingSubmitButton>
      </div>
    </form>
  );
}
