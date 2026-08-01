"use client";

/**
 * Commercial Access manager (admin-only surface). Provisions + manages
 * Commercial-ONLY logins. No role picker — Commercial is single-level access.
 * Talks to the shared /api/admin/access endpoints (admin-gated + audited); the
 * POST here always sends platforms={commercial:true, commandCenter:false}.
 */

import { useState } from "react";
import type { ManagedUser } from "@/lib/auth/user-management";

const INPUT =
  "w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2.5 text-sm text-ppp-charcoal focus:border-cc-brand-500 focus:ring-1 focus:ring-cc-brand-500 outline-none min-h-[44px]";

function genPassword(): string {
  // Readable-ish: avoids ambiguous chars, always mixes classes. No Math.random
  // reliance for security — this is a starter password the admin can change.
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const nums = "23456789";
  const all = lower + upper + nums;
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];
  let out = pick(upper) + pick(lower) + pick(nums);
  for (let i = 0; i < 9; i++) out += pick(all);
  return out;
}

export default function CommercialAccessManager({
  initialUsers,
  currentUserId,
}: {
  initialUsers: ManagedUser[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState<ManagedUser[]>(initialUsers);
  const [flash, setFlash] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);

  const refresh = async () => {
    const res = await fetch("/api/admin/access", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json().catch(() => ({}))) as { users?: ManagedUser[] };
    if (json.users) setUsers(json.users.filter((u) => u.has_new_platform_access));
  };

  const note = (tone: "ok" | "err", msg: string) => {
    setFlash({ tone, msg });
    if (tone === "ok") window.setTimeout(() => setFlash(null), 6000);
  };

  return (
    <div className="space-y-5">
      {flash && (
        <div
          className={`rounded-xl px-4 py-3 text-sm ${
            flash.tone === "ok"
              ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
              : "bg-rose-50 border border-rose-200 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      <AddUserForm
        onCreated={async (msg) => {
          note("ok", msg);
          await refresh();
        }}
        onError={(msg) => note("err", msg)}
      />

      <section className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-ppp-charcoal-100">
          <h2 className="text-[13px] font-bold text-ppp-charcoal">
            Commercial users · {users.length}
          </h2>
        </div>
        {users.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ppp-charcoal-500">
            No Commercial logins yet. Add one above.
          </p>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {users.map((u) => (
              <UserRow
                key={u.user_id}
                user={u}
                isSelf={u.user_id === currentUserId}
                onChanged={async (msg) => {
                  note("ok", msg);
                  await refresh();
                }}
                onError={(msg) => note("err", msg)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ─────────────── Add user ─────────────── */

function AddUserForm({
  onCreated,
  onError,
}: {
  onCreated: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  const generate = () => {
    setPassword(genPassword());
    setShowPw(true);
    setCopied(false);
  };

  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — field is visible for manual copy */
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch("/api/admin/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          full_name: fullName,
          password,
          // Commercial-only grant. No role sent → provisioned non-admin.
          platforms: { commandCenter: false, commercial: true },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error ?? "Could not create the account.");
        return;
      }
      onCreated(`${email} can now sign in to Commercial. Share the email + password.`);
      setEmail("");
      setFullName("");
      setPassword("");
      setShowPw(false);
      setCopied(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-ppp-charcoal-100 bg-surface p-5 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ppp-charcoal">Add a Commercial user</h2>
        <p className="text-xs text-ppp-charcoal-400 mt-0.5">
          They log in with the email + password you set — Commercial access only.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Email</span>
          <input
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@tomcopainting.com"
            className={INPUT}
          />
        </label>
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
            Full name <span className="text-ppp-charcoal-400 font-normal">· optional</span>
          </span>
          <input
            type="text"
            autoComplete="off"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Doe"
            className={INPUT}
          />
        </label>
      </div>

      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
          Password <span className="text-ppp-charcoal-400 font-normal">· at least 8 characters</span>
        </span>
        <div className="flex flex-wrap items-stretch gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <input
              type={showPw ? "text" : "password"}
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Set a password"
              className={`${INPUT} font-mono pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 hover:text-ppp-charcoal-600 p-1 min-h-[36px]"
              aria-label={showPw ? "Hide password" : "Show password"}
            >
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
          <button
            type="button"
            onClick={generate}
            className="inline-flex items-center rounded-lg border border-ppp-charcoal-200 px-3 text-sm font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            Generate
          </button>
          {password && (
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center rounded-lg border border-ppp-charcoal-200 px-3 text-sm font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      </label>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center rounded-lg bg-cc-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cc-brand-700 disabled:opacity-60 min-h-[44px]"
      >
        {pending ? "Adding…" : "Add user"}
      </button>
    </form>
  );
}

/* ─────────────── User row ─────────────── */

function UserRow({
  user,
  isSelf,
  onChanged,
  onError,
}: {
  user: ManagedUser;
  isSelf: boolean;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [newPw, setNewPw] = useState("");
  const label = user.full_name || user.email;

  const patch = async (body: Record<string, unknown>, okMsg: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/access/${user.user_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error ?? "That didn't work.");
        return;
      }
      onChanged(okMsg);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = () =>
    patch(
      { action: "active", is_active: !user.is_active },
      user.is_active
        ? `${label} deactivated — they can no longer sign in.`
        : `${label} reactivated.`
    );

  const doReset = async () => {
    if (newPw.length < 8) {
      onError("Password must be at least 8 characters.");
      return;
    }
    await patch({ action: "reset_password", password: newPw }, `Password reset for ${label}. Share the new one.`);
    setResetOpen(false);
    setNewPw("");
  };

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ppp-charcoal truncate">{label}</span>
            {!user.is_active && (
              <span className="rounded border border-ppp-charcoal-200 bg-ppp-charcoal-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                Inactive
              </span>
            )}
            {user.has_command_center_access && (
              <span className="rounded border border-ppp-blue-200 bg-ppp-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-ppp-blue-700">
                Also PPP
              </span>
            )}
          </div>
          <div className="text-[12px] text-ppp-charcoal-500 mt-0.5 truncate">{user.email}</div>
          <div className="text-[11px] text-ppp-charcoal-400 mt-0.5">
            {user.auth_provider === "password" ? "Email + password" : "Google sign-in"}
            {user.last_login_at ? " · signed in before" : " · never signed in"}
          </div>
        </div>
        {!isSelf && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setResetOpen((v) => !v)}
              disabled={busy}
              className="rounded-lg border border-ppp-charcoal-200 px-2.5 py-1.5 text-[12px] font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 disabled:opacity-60 min-h-[36px]"
            >
              Reset password
            </button>
            <button
              type="button"
              onClick={toggleActive}
              disabled={busy}
              className={`rounded-lg px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-60 min-h-[36px] ${
                user.is_active
                  ? "border border-rose-200 text-rose-700 hover:bg-rose-50"
                  : "border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              }`}
            >
              {user.is_active ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        )}
      </div>
      {resetOpen && !isSelf && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="New password (min 8)"
            className={`${INPUT} font-mono flex-1 min-w-[200px]`}
          />
          <button
            type="button"
            onClick={() => setNewPw(genPassword())}
            className="rounded-lg border border-ppp-charcoal-200 px-3 text-[12px] font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            Generate
          </button>
          <button
            type="button"
            onClick={doReset}
            disabled={busy}
            className="rounded-lg bg-cc-brand-600 px-3 text-[12px] font-semibold text-white hover:bg-cc-brand-700 disabled:opacity-60 min-h-[44px]"
          >
            Save
          </button>
        </div>
      )}
    </li>
  );
}
