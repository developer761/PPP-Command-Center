"use client";

import { useCallback, useMemo, useState } from "react";
import { USER_ROLES, roleLabel, type UserRole } from "@/lib/auth/roles";

/** Mirror of lib/auth/user-management ManagedUser (type-only; that module is server-only). */
type ManagedUser = {
  user_id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  auth_provider: "google" | "password";
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
};

type Banner = { kind: "ok" | "err"; text: string } | null;

const roleBadge: Record<UserRole, string> = {
  admin: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-100",
  account_manager: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100",
  rep: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-100",
};

export default function AccessManager({
  initialUsers,
  currentUserId,
}: {
  initialUsers: ManagedUser[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState<ManagedUser[]>(initialUsers);
  const [banner, setBanner] = useState<Banner>(null);
  const [refreshing, setRefreshing] = useState(false);

  const activeAdmins = useMemo(
    () => users.filter((u) => u.role === "admin" && u.is_active).length,
    [users]
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/access", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.users)) setUsers(json.users);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setBanner({ kind, text });
    if (kind === "ok") {
      window.setTimeout(() => setBanner(null), 4000);
    }
  }, []);

  return (
    <div className="space-y-6">
      {banner && (
        <div
          role="status"
          className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${
            banner.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <span className="mt-0.5 shrink-0">
            {banner.kind === "ok" ? <IconCheck /> : <IconAlert />}
          </span>
          <span className="flex-1">{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="shrink-0 text-current/60 hover:text-current"
            aria-label="Dismiss"
          >
            <IconX />
          </button>
        </div>
      )}

      <AddUserForm onCreated={(msg) => { flash("ok", msg); void refresh(); }} onError={(msg) => flash("err", msg)} />

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400">
            Users
            <span className="ml-2 rounded-full bg-ppp-charcoal-100 px-2 py-0.5 text-[11px] font-semibold text-ppp-charcoal-500">
              {users.length}
            </span>
          </h2>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-ppp-charcoal-400 hover:text-ppp-charcoal-600 min-h-[44px] disabled:opacity-50"
          >
            <span className={refreshing ? "animate-spin" : ""}><IconRefresh /></span>
            Refresh
          </button>
        </div>

        <div className="space-y-3">
          {users.length === 0 && (
            <p className="rounded-lg border border-dashed border-ppp-charcoal-200 px-4 py-8 text-center text-sm text-ppp-charcoal-400">
              No users yet. Add one above.
            </p>
          )}
          {users.map((u) => (
            <UserRow
              key={u.user_id}
              user={u}
              isSelf={u.user_id === currentUserId}
              isLastAdmin={u.role === "admin" && u.is_active && activeAdmins <= 1}
              onDone={(kind, text) => { flash(kind, text); void refresh(); }}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────── Add user ─────────────────────────── */

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
  const [role, setRole] = useState<UserRole>("account_manager");
  const [showPw, setShowPw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  const generate = () => {
    const gen = generatePassword();
    setPassword(gen);
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
      /* clipboard blocked — the field is visible for manual copy */
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
        body: JSON.stringify({ email, full_name: fullName, password, role }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error ?? "Could not create the account.");
        return;
      }
      onCreated(
        `${email} added as ${roleLabel(role)}. Share the email + password so they can sign in.`
      );
      setEmail("");
      setFullName("");
      setPassword("");
      setRole("account_manager");
      setShowPw(false);
      setCopied(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-ppp-charcoal-100 bg-white p-5 space-y-4"
    >
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center h-9 w-9 rounded-lg bg-emerald-50 text-emerald-700">
          <IconUserPlus />
        </span>
        <div>
          <h2 className="text-base font-semibold text-ppp-charcoal">Add a user</h2>
          <p className="text-xs text-ppp-charcoal-400">They log in with the email + password you set below.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Email" required>
          <input
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@precisionpaintingplus.com"
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2.5 text-sm focus:border-ppp-blue focus:ring-1 focus:ring-ppp-blue outline-none min-h-[44px]"
          />
        </Field>
        <Field label="Full name" hint="Optional — used for their greeting">
          <input
            type="text"
            autoComplete="off"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Doe"
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2.5 text-sm focus:border-ppp-blue focus:ring-1 focus:ring-ppp-blue outline-none min-h-[44px]"
          />
        </Field>
      </div>

      <Field label="Password" required hint="At least 8 characters. You can generate one and copy it.">
        <div className="flex flex-wrap items-stretch gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <input
              type={showPw ? "text" : "password"}
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Set a password"
              className="w-full rounded-lg border border-ppp-charcoal-200 pl-3 pr-10 py-2.5 text-sm font-mono focus:border-ppp-blue focus:ring-1 focus:ring-ppp-blue outline-none min-h-[44px]"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 hover:text-ppp-charcoal-600 p-1"
              aria-label={showPw ? "Hide password" : "Show password"}
            >
              {showPw ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
          <button
            type="button"
            onClick={generate}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-200 px-3 text-sm font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            <IconDice /> Generate
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!password}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-200 px-3 text-sm font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 disabled:opacity-40 min-h-[44px]"
          >
            {copied ? <IconCheck /> : <IconCopy />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </Field>

      <Field label="Role">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {USER_ROLES.map((r) => (
            <button
              type="button"
              key={r.value}
              onClick={() => setRole(r.value)}
              className={`text-left rounded-lg border px-3 py-2.5 transition-colors min-h-[44px] ${
                role === r.value
                  ? "border-ppp-blue bg-ppp-blue-50/60 ring-1 ring-ppp-blue"
                  : "border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
              }`}
            >
              <span className="block text-sm font-semibold text-ppp-charcoal">{r.label}</span>
              <span className="block text-[11px] leading-snug text-ppp-charcoal-400 mt-0.5">{r.blurb}</span>
            </button>
          ))}
        </div>
      </Field>

      <div className="flex justify-end pt-1">
        <button
          type="submit"
          disabled={pending || !email || password.length < 8}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-ppp-blue px-5 text-sm font-semibold text-white hover:bg-ppp-blue-600 active:bg-ppp-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
        >
          {pending ? <><IconSpinner /> Adding…</> : <>Add user</>}
        </button>
      </div>
    </form>
  );
}

/* ─────────────────────────── User row ─────────────────────────── */

function UserRow({
  user,
  isSelf,
  isLastAdmin,
  onDone,
}: {
  user: ManagedUser;
  isSelf: boolean;
  isLastAdmin: boolean;
  onDone: (kind: "ok" | "err", text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [showPw, setShowPw] = useState(false);

  const label = user.full_name || user.email.split("@")[0];
  const initial = (label[0] ?? "?").toUpperCase();

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
        onDone("err", json.error ?? "That change didn't go through.");
        return false;
      }
      onDone("ok", okMsg);
      return true;
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (role: UserRole) => {
    if (role === user.role) return;
    await patch({ action: "role", role }, `${label} is now ${roleLabel(role)}.`);
  };

  const toggleActive = async () => {
    const next = !user.is_active;
    await patch(
      { action: "active", is_active: next },
      next ? `${label} reactivated.` : `${label} deactivated — they can no longer sign in.`
    );
  };

  const saveReset = async () => {
    const ok = await patch(
      { action: "reset_password", password: newPw },
      `Password reset for ${label}. Share the new password.`
    );
    if (ok) {
      setResetOpen(false);
      setNewPw("");
      setShowPw(false);
    }
  };

  return (
    <div
      className={`rounded-xl border bg-white p-4 ${
        user.is_active ? "border-ppp-charcoal-100" : "border-ppp-charcoal-100 bg-ppp-charcoal-50/40"
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {/* Identity */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span
            className={`flex items-center justify-center h-10 w-10 rounded-full text-sm font-bold shrink-0 ${
              user.is_active ? "bg-ppp-navy-50 text-ppp-navy-700" : "bg-ppp-charcoal-100 text-ppp-charcoal-400"
            }`}
          >
            {initial}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-ppp-charcoal truncate">{label}</span>
              {isSelf && (
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">You</span>
              )}
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${roleBadge[user.role]}`}>
                {roleLabel(user.role)}
              </span>
              {!user.is_active && (
                <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">Deactivated</span>
              )}
            </div>
            <div className="text-xs text-ppp-charcoal-400 truncate mt-0.5">
              {user.email}
              <span className="mx-1.5 text-ppp-charcoal-200">·</span>
              {user.auth_provider === "password" ? "Password" : "Google"}
              <span className="mx-1.5 text-ppp-charcoal-200">·</span>
              {formatLastLogin(user.last_login_at)}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap sm:justify-end">
          <select
            value={user.role}
            disabled={busy || isSelf || isLastAdmin}
            onChange={(e) => void changeRole(e.target.value as UserRole)}
            title={
              isSelf
                ? "You can't change your own role."
                : isLastAdmin
                ? "Can't demote the last admin."
                : "Change role"
            }
            className="rounded-lg border border-ppp-charcoal-200 bg-white px-2.5 py-2 text-xs font-medium text-ppp-charcoal-600 min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {USER_ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setResetOpen((v) => !v)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-xs font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px] disabled:opacity-50"
          >
            <IconKey /> <span className="hidden sm:inline">Reset password</span><span className="sm:hidden">Password</span>
          </button>

          <button
            type="button"
            onClick={() => void toggleActive()}
            disabled={busy || (isSelf) || (isLastAdmin && user.is_active)}
            title={
              isSelf
                ? "You can't deactivate your own account."
                : isLastAdmin && user.is_active
                ? "Can't deactivate the last admin."
                : undefined
            }
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed ${
              user.is_active
                ? "border border-rose-200 text-rose-600 hover:bg-rose-50"
                : "border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            }`}
          >
            {user.is_active ? "Deactivate" : "Reactivate"}
          </button>
        </div>
      </div>

      {resetOpen && (
        <div className="mt-3 border-t border-ppp-charcoal-100 pt-3">
          <label className="block text-xs font-medium text-ppp-charcoal-500 mb-1.5">
            New password for {label} <span className="text-ppp-charcoal-300">(min 8 characters)</span>
          </label>
          <div className="flex flex-wrap items-stretch gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <input
                type={showPw ? "text" : "password"}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-lg border border-ppp-charcoal-200 pl-3 pr-10 py-2.5 text-sm font-mono focus:border-ppp-blue focus:ring-1 focus:ring-ppp-blue outline-none min-h-[44px]"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 hover:text-ppp-charcoal-600 p-1"
                aria-label={showPw ? "Hide password" : "Show password"}
              >
                {showPw ? <IconEyeOff /> : <IconEye />}
              </button>
            </div>
            <button
              type="button"
              onClick={() => { setNewPw(generatePassword()); setShowPw(true); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-200 px-3 text-sm font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              <IconDice /> Generate
            </button>
            <button
              type="button"
              onClick={() => void saveReset()}
              disabled={busy || newPw.length < 8}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ppp-blue px-4 text-sm font-semibold text-white hover:bg-ppp-blue-600 disabled:opacity-50 min-h-[44px]"
            >
              {busy ? <IconSpinner /> : null} Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-ppp-charcoal-600 mb-1.5">
        {label} {required && <span className="text-rose-500">*</span>}
        {hint && <span className="ml-1 font-normal text-ppp-charcoal-400">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const len = 14;
  const out: string[] = [];
  try {
    const buf = new Uint32Array(len);
    window.crypto.getRandomValues(buf);
    for (let i = 0; i < len; i++) out.push(alphabet[buf[i] % alphabet.length]);
  } catch {
    // Fallback (should never hit in a browser) — still avoids obvious patterns.
    for (let i = 0; i < len; i++) out.push(alphabet[i % alphabet.length]);
  }
  return out.join("");
}

function formatLastLogin(iso: string | null): string {
  if (!iso) return "never signed in";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `last seen ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/* ─────────────────────────── icons ─────────────────────────── */

function IconCheck() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>;
}
function IconAlert() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 9v4 M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /></svg>;
}
function IconX() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>;
}
function IconRefresh() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5" /></svg>;
}
function IconUserPlus() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M19 8v6 M22 11h-6" /></svg>;
}
function IconKey() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15.5 7.5 3 3L22 7l-3-3 M2 22l4.5-4.5" /><circle cx="9" cy="15" r="4" /><path d="m11.8 12.2 4.7-4.7" /></svg>;
}
function IconEye() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
}
function IconEyeOff() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68 M6.6 6.6A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 3.4-.66 M14.1 14.1a3 3 0 1 1-4.2-4.2 M1 1l22 22" /></svg>;
}
function IconCopy() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
}
function IconDice() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" /></svg>;
}
function IconSpinner() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin" aria-hidden><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" /><path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}
