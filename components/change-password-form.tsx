"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Self-service password change. The signed-in user sets a new password for
 * their own account (Supabase `updateUser`). For Google-SSO staff this simply
 * ALSO enables email+password sign-in; for provisioned users it's how they
 * rotate the password an admin gave them.
 */
export default function ChangePasswordForm() {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setMsg(null);
    if (pw.length < 8) {
      setMsg({ kind: "err", text: "Password must be at least 8 characters." });
      return;
    }
    if (pw !== confirm) {
      setMsg({ kind: "err", text: "The two passwords don't match." });
      return;
    }
    setPending(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) {
        setMsg({ kind: "err", text: error.message || "Couldn't update the password." });
        return;
      }
      setMsg({ kind: "ok", text: "Password updated. Use it next time you sign in." });
      setPw("");
      setConfirm("");
      setShowPw(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 max-w-md">
      {msg && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2.5 text-sm ${
            msg.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {msg.text}
        </div>
      )}
      <div>
        <label htmlFor="np" className="block text-xs font-semibold text-ppp-charcoal-600 mb-1">
          New password <span className="font-normal text-ppp-charcoal-400">(min 8 characters)</span>
        </label>
        <div className="relative">
          <input
            id="np"
            type={showPw ? "text" : "password"}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="new-password"
            className="w-full rounded-lg border border-ppp-charcoal-200 pl-3 pr-10 py-2.5 text-sm focus:border-ppp-blue focus:ring-1 focus:ring-ppp-blue outline-none min-h-[44px]"
          />
          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 hover:text-ppp-charcoal-600 p-1"
            aria-label={showPw ? "Hide password" : "Show password"}
          >
            {showPw ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68 M6.6 6.6A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 3.4-.66 M14.1 14.1a3 3 0 1 1-4.2-4.2 M1 1l22 22" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
            )}
          </button>
        </div>
      </div>
      <div>
        <label htmlFor="cp" className="block text-xs font-semibold text-ppp-charcoal-600 mb-1">
          Confirm password
        </label>
        <input
          id="cp"
          type={showPw ? "text" : "password"}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2.5 text-sm focus:border-ppp-blue focus:ring-1 focus:ring-ppp-blue outline-none min-h-[44px]"
        />
      </div>
      <button
        type="submit"
        disabled={pending || !pw || !confirm}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-ppp-blue px-5 text-sm font-semibold text-white hover:bg-ppp-blue-600 active:bg-ppp-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
      >
        {pending ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
