"use client";

import { useMemo, useState } from "react";

type ProxyUser = {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
};

/**
 * The list an admin picks from to log in as somebody else.
 *
 * Searchable rather than a bare list — Karan's standing rule for anything past
 * a dozen entries, and PPP's user list is already longer than that.
 *
 * A deactivated account is shown but cannot be entered: proxying into one
 * would be the only way to use a login the Access tab has switched off.
 */
export default function ProxyPicker({
  users,
  proxyingAs,
}: {
  users: ProxyUser[];
  proxyingAs: string | null;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((u) =>
      [u.name ?? "", u.email, u.role].some((f) => f.toLowerCase().includes(needle))
    );
  }, [q, users]);

  async function loginAs(u: ProxyUser) {
    setBusy(u.userId);
    setError(null);
    try {
      const res = await fetch("/api/admin/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: u.userId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setError(body.message ?? body.error ?? `Couldn't start the session (HTTP ${res.status}).`);
        setBusy(null);
        return;
      }
      // Full reload, not a router push: every server component and the shell
      // itself has to re-render as the other person.
      window.location.assign("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {proxyingAs && (
        <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl px-4 py-3 text-sm text-ppp-orange-700">
          You are currently logged in as <strong>{proxyingAs}</strong>. Use the bar at the top of the
          page to come back to your own account.
        </div>
      )}

      <div className="bg-white border border-ppp-charcoal-100 rounded-2xl overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-ppp-charcoal-100">
          <label htmlFor="proxy-search" className="sr-only">Search people</label>
          <input
            id="proxy-search"
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, email or role…"
            className="w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
          />
        </div>

        {error && (
          <p className="px-4 sm:px-5 py-2 text-xs text-ppp-orange-700 border-b border-ppp-charcoal-100">
            {error}
          </p>
        )}

        <ul className="divide-y divide-ppp-charcoal-100">
          {shown.length === 0 && (
            <li className="px-4 sm:px-5 py-6 text-sm text-ppp-charcoal-500">
              Nobody matches “{q}”.
            </li>
          )}
          {shown.map((u) => (
            <li key={u.userId} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-sm text-ppp-charcoal truncate">
                  {u.name || u.email}
                  {!u.isActive && (
                    <span className="ml-2 text-[10px] font-medium uppercase tracking-wider text-ppp-charcoal-500">
                      deactivated
                    </span>
                  )}
                </div>
                <div className="text-xs text-ppp-charcoal-500 truncate">
                  {u.email} · {u.role.replace(/_/g, " ")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => loginAs(u)}
                disabled={!u.isActive || busy !== null}
                className="shrink-0 text-sm font-semibold px-3 py-2 rounded-lg border border-ppp-blue-200 text-ppp-blue-700 hover:bg-ppp-blue-50 disabled:opacity-40 disabled:hover:bg-transparent min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
              >
                {busy === u.userId ? "Starting…" : "Log in as"}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-ppp-charcoal-500 leading-relaxed">
        While you are logged in as somebody else you have their permissions, not your own — that is
        the point, and it is how a problem they reported becomes reproducible. Anything you save is
        still recorded against your own account, and every proxy session is written to the audit log.
      </p>
    </div>
  );
}
