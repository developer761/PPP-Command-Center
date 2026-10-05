"use client";

import { useState } from "react";

/**
 * The state you work in, which decides which vendors you can order from.
 *
 * Karan 2026-10-05: "everyone can set their own states by clicking account
 * settings on the top right and they add their own states and moving forward as
 * well." Until now the only control was on Settings → Access & Users, which is
 * admin-only — fine for correcting one person, hopeless for onboarding twenty.
 *
 * Says what it CHANGES, not what it is. "Your state" reads like an address
 * field somebody can safely ignore; "which vendors you see" is the actual
 * consequence, and it's the thing that makes an empty box worth filling in.
 *
 * Free text capped at two characters rather than a NY/NJ/FL dropdown, matching
 * the admin editor and the vendor editor. PPP works in three states today and a
 * fourth needs no code change — a dropdown would have to be edited to hire
 * somebody in Connecticut.
 */
export default function AccountStateForm({ initial }: { initial: string | null }) {
  const [state, setState] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clean = state.trim().toUpperCase();
  const dirty = clean !== (initial ?? "").trim().toUpperCase();
  // A single letter is a half-typed code, not a state. Saving it would be
  // silently rejected by the API, so the button stays disabled and says so.
  const incomplete = clean.length === 1;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedAs(null);
    try {
      const res = await fetch("/api/account/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: clean }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        state?: string | null;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.message ?? "Couldn't save that. Try again.");
        return;
      }
      setSavedAs(data.state ?? "");
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <label
        htmlFor="account-state"
        className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500"
      >
        The state you work in
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="account-state"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={2}
          value={state}
          onChange={(e) => {
            setState(e.target.value.toUpperCase().slice(0, 2));
            setSavedAs(null);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty && !incomplete && !saving) {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="NY"
          aria-describedby="account-state-help"
          className="w-20 px-3 py-2.5 sm:py-2 text-base sm:text-sm uppercase tracking-widest font-medium border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty || incomplete}
          className="px-4 py-2.5 min-h-[44px] sm:min-h-0 rounded-lg bg-ppp-navy text-white text-sm font-semibold hover:bg-ppp-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors touch-manipulation"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p id="account-state-help" className="text-[11px] text-ppp-charcoal-500 leading-snug">
        Two letters — <span className="font-medium">NY</span>,{" "}
        <span className="font-medium">NJ</span> or <span className="font-medium">FL</span>. You&rsquo;ll
        only see the paint stores in that state when you order, and you can star
        the ones you use most. Leave it blank to see every vendor we have.
      </p>
      {incomplete && (
        <p role="status" className="text-[11px] font-medium text-ppp-charcoal-500">
          Two letters, like NY.
        </p>
      )}
      {savedAs !== null && (
        <p role="status" className="text-[11px] font-medium text-ppp-green-700">
          {savedAs
            ? `Saved. You'll see ${savedAs} vendors when you order.`
            : "Cleared. You'll see every vendor when you order."}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] font-medium text-ppp-orange-700">
          {error}
        </p>
      )}
    </div>
  );
}
