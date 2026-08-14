"use client";

import { useState } from "react";
import CommercialAddressFields from "@/components/commercial-address-fields";

/**
 * Wraps the BILLING address section with a "Same as company address"
 * checkbox. When checked, the billing inputs collapse and a hidden flag
 * (`site_same_as_billing=1`) is submitted so the server copies the company
 * (site_*) address into billing_* without the user re-typing four fields.
 * When unchecked, the user types a separate BILLING address.
 *
 * Karan 2026-06-24 (UX audit fix): most accounts have billing = site;
 * forcing two identical addresses was a major friction point on the
 * create flow.
 *
 * Defaults to UNCHECKED on the create form (no prior context); the
 * edit form passes `defaultChecked` based on whether the existing
 * site address matches billing.
 */
type Defaults = {
  street?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
};

export default function CommercialSiteAddressToggle({
  defaultChecked = false,
  defaults,
}: {
  defaultChecked?: boolean;
  defaults?: Defaults;
}) {
  const [same, setSame] = useState(defaultChecked);
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none min-h-[44px] touch-manipulation">
        <input
          type="checkbox"
          name="site_same_as_billing"
          value="1"
          checked={same}
          onChange={(e) => setSame(e.target.checked)}
          className="h-4 w-4 rounded border-ppp-charcoal-300 text-cc-brand-600 focus:ring-cc-brand-600/30"
        />
        <span className="text-ppp-charcoal-700">Same as company address</span>
      </label>
      {!same && (
        // prefix="billing", NOT "site".
        //
        // Both callers mount this inside their "Billing address" section and
        // pass the account's BILLING values into it, but it rendered inputs
        // named site_*. Two consequences, both silent:
        //   1. the edit action reads get("billing_street") and found nothing,
        //      so a separate billing address was never saved
        //   2. site_* was then submitted TWICE on the same form — once by the
        //      Company address section above — and the later value won, so
        //      entering a billing address overwrote the company address
        // The "same as company address" path is unaffected: it submits
        // site_same_as_billing=1 and the action copies site_* into billing_*.
        //
        // Found by the 2026-08-13 persona audit. The 2026-08-12 note on the
        // edit page called this exact class "second time an edit page was
        // missed after a create-form change" — this was the half still left.
        <CommercialAddressFields prefix="billing" defaults={defaults} />
      )}
    </div>
  );
}
