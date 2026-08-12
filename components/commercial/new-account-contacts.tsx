"use client";

import { useState } from "react";

/**
 * Contacts, on the form that creates the account.
 *
 * Brendan 2026-08-12: *"Add a section to the new account creation form for
 * adding contacts — owner, billing, estimating, field. For example while
 * entering a new builder we can add an estimator's contact at the same time, so
 * when we go to send the proposal it's already pre-populated."*
 *
 * The reasoning is the point. The estimator's email is known at the moment
 * somebody types the builder's name, and needed weeks later when a proposal
 * goes out. Anything not captured in that first minute gets captured under
 * time pressure later, or looked up in an inbox — which is where "who do we
 * send this to?" comes from.
 *
 * FOUR ROWS, one per role Brendan named, all optional. Not a repeater with an
 * "add another" button: a fixed four says what the form expects, and an empty
 * row costs nothing. Rows left blank are skipped entirely — a name is what
 * makes a row real, so email or phone alone is ignored rather than creating a
 * nameless contact.
 */

const ROWS = [
  { key: "owner", role: "decision_maker", label: "Owner / decision maker" },
  { key: "estimating", role: "estimator", label: "Estimating" },
  { key: "billing", role: "billing", label: "Billing" },
  { key: "field", role: "site", label: "Field" },
] as const;

export function NewAccountContacts({
  defaults,
}: {
  /** Re-populated from the URL when the server bounces the form back with an
   *  error — otherwise a validation failure silently eats every contact typed. */
  defaults?: Record<string, string | undefined>;
}) {
  const [open, setOpen] = useState(
    // Expanded when the user already typed something and got bounced back.
    ROWS.some((r) => defaults?.[`c_${r.key}_name`])
  );

  return (
    <div className="space-y-2.5">
      <p className="text-[12px] text-ppp-charcoal-500">
        Optional, and worth thirty seconds — an estimator added here is already
        filled in when you send them a proposal.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px]"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          Add contacts
        </button>
      ) : (
        <div className="space-y-3">
          {ROWS.map((r) => (
            <fieldset key={r.key} className="border border-ppp-charcoal-100 rounded-lg p-3">
              <legend className="px-1 text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">
                {r.label}
              </legend>
              <input type="hidden" name={`c_${r.key}_role`} value={r.role} />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <input
                  name={`c_${r.key}_name`}
                  defaultValue={defaults?.[`c_${r.key}_name`] ?? ""}
                  placeholder="Name"
                  autoComplete="off"
                  // text-base on mobile or iOS zooms on focus and never returns.
                  className="w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-2.5 py-2 text-base sm:text-[13px] min-h-[44px] sm:min-h-[38px]"
                />
                <input
                  name={`c_${r.key}_email`}
                  type="email"
                  defaultValue={defaults?.[`c_${r.key}_email`] ?? ""}
                  placeholder="Email"
                  autoComplete="off"
                  className="w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-2.5 py-2 text-base sm:text-[13px] min-h-[44px] sm:min-h-[38px]"
                />
                <input
                  name={`c_${r.key}_phone`}
                  type="tel"
                  defaultValue={defaults?.[`c_${r.key}_phone`] ?? ""}
                  placeholder="Phone"
                  autoComplete="off"
                  className="w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-2.5 py-2 text-base sm:text-[13px] min-h-[44px] sm:min-h-[38px]"
                />
              </div>
            </fieldset>
          ))}
          <p className="text-[11px] text-ppp-charcoal-400">
            Leave any of these blank — only rows with a name are saved.
          </p>
        </div>
      )}
    </div>
  );
}
