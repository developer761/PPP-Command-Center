"use client";

import { useState } from "react";

/**
 * The number a supplier calls about your orders.
 *
 * Karan 2026-09-09. `profiles.phone` has been read by the order flow since
 * migration 145 and printed on the vendor email's contact block — but nothing
 * ever wrote to it, so it was blank for everyone. This is that missing field.
 *
 * Says where the number ENDS UP, not what it is. "Phone number" on its own
 * invites people to leave it blank; knowing a vendor will ring it is what makes
 * filling it in obviously worth doing.
 */
export default function AccountPhoneForm({ initial }: { initial: string | null }) {
  const [phone, setPhone] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = phone.trim() !== (initial ?? "").trim();

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/account/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.message ?? "Couldn't save that. Try again.");
        return;
      }
      setSaved(true);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor="account-phone" className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500">
        Your phone number
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="account-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => { setPhone(e.target.value); setSaved(false); }}
          placeholder="(516) 555-0123"
          className="flex-1 min-w-[200px] px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="px-4 py-2.5 min-h-[44px] sm:min-h-0 rounded-lg bg-ppp-navy text-white text-sm font-semibold hover:bg-ppp-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors touch-manipulation"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-[11px] text-ppp-charcoal-500 leading-snug">
        Goes on every material order you send, so the supplier knows who to call
        about it. Leave it blank and the order says there is no number.
      </p>
      {saved && <p role="status" className="text-[11px] font-medium text-ppp-green-700">Saved.</p>}
      {error && <p role="alert" className="text-[11px] font-medium text-ppp-orange-700">{error}</p>}
    </div>
  );
}
