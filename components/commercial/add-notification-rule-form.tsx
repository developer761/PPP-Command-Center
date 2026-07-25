"use client";

import { useState } from "react";
import {
  RULE_TRIGGERS,
  TRIGGER_META,
  type RuleTrigger,
} from "@/lib/commercial/notification-rules/constants";

/**
 * Add-rule form (Block 3B). Client-side only for the dynamic bits: the "N days"
 * field shows/hides based on the trigger, and the default day count follows the
 * trigger. Submits to a server action passed in as `action`.
 */
export default function AddNotificationRuleForm({
  action,
}: {
  action: (formData: FormData) => void;
}) {
  const [trigger, setTrigger] = useState<RuleTrigger>("invoice_overdue");
  const meta = TRIGGER_META[trigger];
  const [days, setDays] = useState<number>(meta.defaultDays);

  const onTriggerChange = (t: RuleTrigger) => {
    setTrigger(t);
    setDays(TRIGGER_META[t].defaultDays);
  };

  return (
    <form
      action={action}
      className="rounded-xl border border-ppp-charcoal-100 bg-white p-4 sm:p-5 space-y-4"
    >
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center h-9 w-9 rounded-lg bg-cc-brand-50 text-cc-brand-700">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0 M18 2l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
          </svg>
        </span>
        <div>
          <h3 className="text-base font-semibold text-ppp-charcoal">Create a custom alert</h3>
          <p className="text-xs text-ppp-charcoal-500">Choose what to watch for and how you want to hear about it.</p>
        </div>
      </div>

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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">Alert me when…</span>
          <select
            name="trigger"
            value={trigger}
            onChange={(e) => onTriggerChange(e.target.value as RuleTrigger)}
            className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]"
          >
            {RULE_TRIGGERS.map((t) => (
              <option key={t} value={t}>{TRIGGER_META[t].label}</option>
            ))}
          </select>
          <span className="block mt-1 text-[11px] text-ppp-charcoal-500">{meta.blurb}</span>
        </label>

        <label className="block">
          <span className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">How to notify me</span>
          <select
            name="channel"
            defaultValue="both"
            className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]"
          >
            <option value="both">In-app + email</option>
            <option value="bell">In-app only</option>
            <option value="email">Email only</option>
          </select>
        </label>
      </div>

      {/* Threshold — only for triggers that use it. Always render the hidden
          input so the server gets a value (0 for followup_due). */}
      {meta.usesThreshold ? (
        <label className="block max-w-[220px]">
          <span className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">Number of days</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              name="threshold_days"
              min={0}
              max={365}
              value={days}
              onChange={(e) => setDays(Math.max(0, Math.min(365, Number(e.target.value) || 0)))}
              inputMode="numeric"
              className="w-24 px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px] tabular-nums"
            />
            <span className="text-[13px] text-ppp-charcoal-500">{meta.thresholdNoun}</span>
          </div>
        </label>
      ) : (
        <input type="hidden" name="threshold_days" value={0} />
      )}

      <div className="flex justify-end pt-1">
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-cc-brand-600 px-5 text-sm font-semibold text-white hover:bg-cc-brand-700 active:bg-cc-brand-700 transition-colors min-h-[44px] touch-manipulation"
        >
          Create alert
        </button>
      </div>
    </form>
  );
}
