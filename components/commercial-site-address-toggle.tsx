"use client";

import { useState } from "react";
import CommercialAddressFields from "@/components/commercial-address-fields";

/**
 * Wraps the Primary Site Address section with a "Same as billing"
 * checkbox. When checked, the address fields collapse and a hidden flag
 * (`site_same_as_billing=1`) is submitted so the server can copy
 * billing_* into site_* without the user re-typing 4 fields.
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
        <span className="text-ppp-charcoal-700">Same as billing address</span>
      </label>
      {!same && (
        <CommercialAddressFields prefix="site" defaults={defaults} />
      )}
    </div>
  );
}
