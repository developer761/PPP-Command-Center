"use client";

/**
 * Commercial Access manager (admin-only surface). Provisions + manages
 * Commercial-ONLY logins. No role picker — Commercial is single-level access.
 * Talks to the shared /api/admin/access endpoints (admin-gated + audited); the
 * POST here always sends platforms={commercial:true, commandCenter:false}.
 */

import { useState } from "react";
import type { ManagedUser } from "@/lib/auth/user-management";
import { SubmitButton } from "@/components/commercial/submit-button";

const INPUT =
  "w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2.5 text-base sm:text-sm text-ppp-charcoal focus:border-cc-brand-500 focus:ring-1 focus:ring-cc-brand-500 outline-none min-h-[44px]";

function genPassword(): string {
  // Readable-ish: avoids ambiguous chars, always mixes classes. No Math.random
  // reliance for security — this is a starter password the admin can change.
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const nums = "23456789";
  const all = lower + upper + nums;
  // Use the CSPRNG for credentials, not Math.random (a starter password an admin
  // may hand out and the user may never change should not rest on a weak PRNG).
  const pick = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  let out = pick(upper) + pick(lower) + pick(nums);
  for (let i = 0; i < 9; i++) out += pick(all);
  return out;
}

export default function CommercialAccessManager({
  initialUsers,
  currentUserId,
  initialApproverEmails = [],
  initialReceiverEmails = [],
  crewUserIds = [],
  emailOnUserIds = [],
  toggleCrewAction,
  toggleUserEmailAction,
}: {
  initialUsers: ManagedUser[];
  currentUserId: string;
  /**
   * Karan 2026-08-21: "the whole access page is so messy, unorganized,
   * confusing".
   *
   * It listed the same five people THREE times — once as Commercial users,
   * again under "Crew logins", again under schedule emails — and the crew
   * section's rows were mostly the dead text "Admin — always unrestricted".
   * Worse, the per-user NOTIFICATION EMAIL toggle lived inside "Crew logins",
   * which is the last place anyone would look for it and is very likely part of
   * why nobody could work out who was getting emailed.
   *
   * One person, one row, everything about them on it.
   */
  crewUserIds?: string[];
  emailOnUserIds?: string[];
  toggleCrewAction?: (fd: FormData) => Promise<void>;
  toggleUserEmailAction?: (fd: FormData) => Promise<void>;
  /** R1d: emails flagged as proposal approvers (admins are always approvers). */
  initialApproverEmails?: string[];
  /** RUX-6: emails flagged to get pinged on proposal approve / changes-requested. */
  initialReceiverEmails?: string[];
}) {
  const [users, setUsers] = useState<ManagedUser[]>(initialUsers);
  const [approverEmails, setApproverEmails] = useState<string[]>(
    initialApproverEmails.map((e) => e.trim().toLowerCase())
  );
  const [receiverEmails, setReceiverEmails] = useState<string[]>(
    initialReceiverEmails.map((e) => e.trim().toLowerCase())
  );
  const [togglingApprover, setTogglingApprover] = useState(false);
  const [togglingReceiver, setTogglingReceiver] = useState(false);
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

  // R1d: toggle a user as a proposal approver — an explicit on/off flag,
  // independent of admin. Optimistic — reverts + flashes on failure. Serialized
  // (togglingApprover) so two quick toggles on different rows can't paint a
  // stale list from out-of-order responses (the server write itself is atomic).
  const toggleApprover = async (email: string, make: boolean, label: string) => {
    const norm = email.trim().toLowerCase();
    setTogglingApprover(true);
    setApproverEmails((prev) =>
      make ? [...new Set([...prev, norm])] : prev.filter((e) => e !== norm)
    );
    try {
      const res = await fetch("/api/commercial/approvers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: norm, make }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        approver_emails?: string[];
      };
      if (!res.ok) {
        setApproverEmails((prev) =>
          make ? prev.filter((e) => e !== norm) : [...new Set([...prev, norm])]
        );
        note("err", json.error ?? "Couldn't update approvers.");
        return;
      }
      if (json.approver_emails) {
        setApproverEmails(json.approver_emails.map((e) => e.trim().toLowerCase()));
      }
      note(
        "ok",
        make
          ? `${label} can now approve proposals.`
          : `${label} can no longer approve proposals.`
      );
    } catch {
      setApproverEmails((prev) =>
        make ? prev.filter((e) => e !== norm) : [...new Set([...prev, norm])]
      );
      note("err", "Network error — try again.");
    } finally {
      setTogglingApprover(false);
    }
  };

  // RUX-6: toggle a user as a proposal-decision receiver — mirrors the approver
  // toggle. Optimistic, serialized, atomic server write.
  const toggleReceiver = async (email: string, make: boolean, label: string) => {
    const norm = email.trim().toLowerCase();
    setTogglingReceiver(true);
    setReceiverEmails((prev) =>
      make ? [...new Set([...prev, norm])] : prev.filter((e) => e !== norm)
    );
    try {
      const res = await fetch("/api/commercial/receivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: norm, make }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        receiver_emails?: string[];
      };
      if (!res.ok) {
        setReceiverEmails((prev) =>
          make ? prev.filter((e) => e !== norm) : [...new Set([...prev, norm])]
        );
        note("err", json.error ?? "Couldn't update receivers.");
        return;
      }
      if (json.receiver_emails) {
        setReceiverEmails(json.receiver_emails.map((e) => e.trim().toLowerCase()));
      }
      note(
        "ok",
        make
          ? `${label} will now be notified when a proposal is approved or sent back.`
          : `${label} will no longer be notified about proposal decisions.`
      );
    } catch {
      setReceiverEmails((prev) =>
        make ? prev.filter((e) => e !== norm) : [...new Set([...prev, norm])]
      );
      note("err", "Network error — try again.");
    } finally {
      setTogglingReceiver(false);
    }
  };

  const approverCount = users.filter((u) =>
    approverEmails.includes((u.email ?? "").trim().toLowerCase())
  ).length;

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

      {/* R1d: hard-gate safety net. With zero approvers, no proposal can be
          approved → none can be sent to a GC. Warn loudly so nobody's stuck. */}
      {approverCount === 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
          <strong>No proposal approvers yet.</strong> A proposal must be approved before it can be sent to a GC — until you flag at least one approver below, proposals can&rsquo;t go out. Turn on <em>Approver</em> for whoever should sign off (e.g. Brendan, Stephanie).
        </div>
      )}

      {/* People first, form second. The page used to open with an empty
          create-user form — so the answer to "who has access?", which is why
          anyone opens this page, sat below a task almost nobody was doing. */}
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
                isApprover={approverEmails.includes((u.email ?? "").trim().toLowerCase())}
                onToggleApprover={toggleApprover}
                toggleLocked={togglingApprover}
                isReceiver={receiverEmails.includes((u.email ?? "").trim().toLowerCase())}
                onToggleReceiver={toggleReceiver}
                receiverToggleLocked={togglingReceiver}
                isCrew={crewUserIds.includes(u.user_id)}
                emailsOn={emailOnUserIds.includes(u.user_id)}
                toggleCrewAction={toggleCrewAction}
                toggleUserEmailAction={toggleUserEmailAction}
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

      <details className="mt-4 rounded-xl border border-ppp-charcoal-100 bg-surface">
        <summary className="list-none cursor-pointer px-4 py-3 text-[13px] font-semibold text-cc-brand-700 min-h-[44px] flex items-center">
          + Add a Commercial user
        </summary>
        <div className="px-1 pb-1">
          <AddUserForm
            onCreated={async (msg) => {
              note("ok", msg);
              await refresh();
            }}
            onError={(msg) => note("err", msg)}
          />
        </div>
      </details>
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
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 hover:text-ppp-charcoal-600 p-1 min-h-[44px] sm:min-h-[36px]"
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
  isApprover,
  onToggleApprover,
  toggleLocked,
  isReceiver,
  onToggleReceiver,
  receiverToggleLocked,
  isCrew = false,
  emailsOn = false,
  toggleCrewAction,
  toggleUserEmailAction,
  onChanged,
  onError,
}: {
  user: ManagedUser;
  isSelf: boolean;
  isApprover: boolean;
  onToggleApprover: (email: string, make: boolean, label: string) => Promise<void>;
  toggleLocked: boolean;
  isReceiver: boolean;
  onToggleReceiver: (email: string, make: boolean, label: string) => Promise<void>;
  receiverToggleLocked: boolean;
  isCrew?: boolean;
  emailsOn?: boolean;
  toggleCrewAction?: (fd: FormData) => Promise<void>;
  toggleUserEmailAction?: (fd: FormData) => Promise<void>;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [approverBusy, setApproverBusy] = useState(false);
  const [receiverBusy, setReceiverBusy] = useState(false);
  const label = user.full_name || user.email;
  /**
   * Name / title / phone — the three fields the proposal SIGN-OFF prints.
   *
   * Stephanie asked for a sign-off reading "Brendan Dwyer / Lead Estimator,
   * Tomco Painting / 631-300-8984 / Brendan@Tomcopainting.com". The layout was
   * rebuilt to match and it still printed "Brendan" and the company
   * switchboard, because the record held nothing else: `title` had no editor
   * anywhere, `phone` had one only on the RESIDENTIAL Access screen, and
   * `full_name` was write-once at account creation. Commercial users — the
   * people who actually sign proposals — could reach none of them.
   */
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(user.full_name ?? "");
  const [titleDraft, setTitleDraft] = useState(user.title ?? "");
  const [phoneDraft, setPhoneDraft] = useState(user.phone ?? "");

  const doToggleApprover = async () => {
    if (approverBusy) return;
    setApproverBusy(true);
    try {
      await onToggleApprover(user.email, !isApprover, label);
    } finally {
      setApproverBusy(false);
    }
  };

  const doToggleReceiver = async () => {
    if (receiverBusy) return;
    setReceiverBusy(true);
    try {
      await onToggleReceiver(user.email, !isReceiver, label);
    } finally {
      setReceiverBusy(false);
    }
  };

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

  const saveIdentity = async () => {
    // Three separate PATCHes because each is separately audited. Only the ones
    // that actually changed are sent.
    const jobs: Array<[Record<string, unknown>, string]> = [];
    if (nameDraft.trim() !== (user.full_name ?? "")) {
      jobs.push([{ action: "name", full_name: nameDraft.trim() || null }, "name"]);
    }
    if (titleDraft.trim() !== (user.title ?? "")) {
      jobs.push([{ action: "title", title: titleDraft.trim() || null }, "title"]);
    }
    if (phoneDraft.trim() !== (user.phone ?? "")) {
      jobs.push([{ action: "phone", phone: phoneDraft.trim() || null }, "phone"]);
    }
    if (jobs.length === 0) { setEditing(false); return; }
    for (const [body] of jobs) {
      await patch(body, "");
    }
    onChanged(`Saved — these print on proposals ${nameDraft.trim() || label} signs.`);
    setEditing(false);
  };

  const toggleActive = () => {
    // Deactivating cuts off a login immediately — confirm it (reactivating is safe).
    if (user.is_active && !window.confirm(`Deactivate ${label}? They will no longer be able to sign in.`)) return;
    patch(
      { action: "active", is_active: !user.is_active },
      user.is_active
        ? `${label} deactivated — they can no longer sign in.`
        : `${label} reactivated.`
    );
  };

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
            {isApprover && (
              <span
                className="rounded border border-ppp-green-100 bg-ppp-green-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ppp-green-700"
                title="Can approve proposals before they're sent to a GC."
              >
                Approver
              </span>
            )}
            {isReceiver && (
              <span
                className="rounded border border-ppp-blue-200 bg-ppp-blue-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ppp-blue-700"
                title="Gets notified when a proposal is approved or sent back with changes."
              >
                Receiver
              </span>
            )}
          </div>
          <div className="text-[12px] text-ppp-charcoal-500 mt-0.5 truncate">{user.email}</div>
          <div className="text-[11px] text-ppp-charcoal-400 mt-0.5">
            {user.auth_provider === "password" ? "Email + password" : "Google sign-in"}
            {user.last_login_at ? " · signed in before" : " · never signed in"}
          </div>

          {/* Details that print on a proposal sign-off. */}
          {editing ? (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 mb-0.5">Full name</span>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="Brendan Dwyer"
                  aria-label="Full name"
                  className="w-full rounded border border-ppp-charcoal-200 px-2 py-1 text-base sm:text-[12px] min-h-[44px] sm:min-h-0 focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 mb-0.5">Title</span>
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  placeholder="Lead Estimator"
                  aria-label="Job title"
                  className="w-full rounded border border-ppp-charcoal-200 px-2 py-1 text-base sm:text-[12px] min-h-[44px] sm:min-h-0 focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 mb-0.5">Phone</span>
                <input
                  type="tel"
                  inputMode="tel"
                  value={phoneDraft}
                  onChange={(e) => setPhoneDraft(e.target.value)}
                  placeholder="631-300-8984"
                  aria-label="Contact phone"
                  className="w-full rounded border border-ppp-charcoal-200 px-2 py-1 text-base sm:text-[12px] min-h-[44px] sm:min-h-0 focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40"
                />
              </label>
              <div className="sm:col-span-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveIdentity()}
                  disabled={busy}
                  className="rounded-lg bg-cc-brand-600 px-3 py-1.5 text-[12px] font-semibold text-white min-h-[44px] sm:min-h-[32px] disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNameDraft(user.full_name ?? "");
                    setTitleDraft(user.title ?? "");
                    setPhoneDraft(user.phone ?? "");
                    setEditing(false);
                  }}
                  className="px-2 py-1 text-[12px] text-ppp-charcoal-500 min-h-[44px] sm:min-h-[32px]"
                >
                  Cancel
                </button>
                <span className="text-[11px] text-ppp-charcoal-400">These print under the signature line on proposals they send.</span>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] text-cc-brand-700 hover:underline min-h-[44px] sm:min-h-0 touch-manipulation"
            >
              {/* Name is in here too, and the label has to say so: Brendan's
                  profile reads "Brendan" and needs to read "Brendan Dwyer" on
                  a proposal. A label naming only title and phone gives nobody
                  a reason to look for the name. */}
              {user.title || user.phone ? (
                <>✎ {[user.full_name, user.title, user.phone].filter(Boolean).join(" · ")}</>
              ) : (
                <>✎ Set name, title &amp; phone <span className="text-ppp-charcoal-400">— they print on proposal sign-offs</span></>
              )}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {/* R1d: proposal-approval toggle — an explicit on/off flag,
              independent of admin. Shown on EVERY row (including yourself)
              so you can pick exactly who signs off proposals. */}
          <button
            type="button"
            onClick={doToggleApprover}
            disabled={approverBusy || toggleLocked || !user.is_active}
            title={
              !user.is_active
                ? "Reactivate this user before making them an approver."
                : isApprover
                ? "Turn off — they can no longer approve proposals."
                : "Turn on — they can approve proposals before they go to a GC."
            }
            aria-pressed={isApprover}
            className={`rounded-lg px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-60 min-h-[44px] sm:min-h-[36px] ${
              isApprover
                ? "border border-ppp-green-100 bg-ppp-green-50 text-ppp-green-700 hover:bg-ppp-green-100"
                : "border border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
            }`}
          >
            {approverBusy
              ? "…"
              : isApprover
              ? "✓ Approver"
              : "Make approver"}
          </button>
          {/* RUX-6: proposal-decision receiver toggle — who gets pinged on
              approve / changes-requested. Independent of approver + admin. */}
          <button
            type="button"
            onClick={doToggleReceiver}
            disabled={receiverBusy || receiverToggleLocked || !user.is_active}
            title={
              !user.is_active
                ? "Reactivate this user before making them a receiver."
                : isReceiver
                ? "Turn off — they'll no longer be notified about proposal decisions."
                : "Turn on — they'll be pinged when a proposal is approved or sent back."
            }
            aria-pressed={isReceiver}
            className={`rounded-lg px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-60 min-h-[44px] sm:min-h-[36px] ${
              isReceiver
                ? "border border-ppp-blue-200 bg-ppp-blue-50 text-ppp-blue-700 hover:bg-ppp-blue-100"
                : "border border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
            }`}
          >
            {receiverBusy ? "…" : isReceiver ? "✓ Receiver" : "Make receiver"}
          </button>
          {/* Notification email — moved here from the "Crew logins" section,
              where it had nothing to do with the heading above it and was
              effectively hidden. This is the switch that decides whether a
              person gets an EMAIL as well as a bell. */}
          {toggleUserEmailAction && (
            <form action={toggleUserEmailAction}>
              <input type="hidden" name="user_id" value={user.user_id} />
              <input type="hidden" name="email" value={user.email ?? ""} />
              <input type="hidden" name="enable" value={emailsOn ? "0" : "1"} />
              <SubmitButton
                title={
                  emailsOn
                    ? `Emailing ${user.email} for every notification. Click to stop.`
                    : `Bell only right now — click to email ${user.email} as well.`
                }
                className={`rounded-lg px-2.5 py-1.5 text-[12px] font-semibold min-h-[44px] sm:min-h-[36px] touch-manipulation ${
                  emailsOn
                    ? "border border-emerald-300 bg-emerald-50 text-emerald-800"
                    : "border border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                }`}
              >
                {emailsOn ? "✓ Emails" : "Bell only"}
              </SubmitButton>
            </form>
          )}
          {/* Crew restriction — only where it can actually apply. An admin row
              used to print "Admin — always unrestricted", which is a sentence
              of dead text on every admin, on a page that already had too many
              of them. */}
          {toggleCrewAction && user.role !== "admin" && (
            <form action={toggleCrewAction}>
              <input type="hidden" name="user_id" value={user.user_id} />
              <input type="hidden" name="make_crew" value={isCrew ? "0" : "1"} />
              <SubmitButton
                title="A crew login reaches only their schedule, calendar, hours and the PIN clock — everything else redirects."
                className={`rounded-lg px-2.5 py-1.5 text-[12px] font-semibold min-h-[44px] sm:min-h-[36px] touch-manipulation ${
                  isCrew
                    ? "border border-cc-brand-600 bg-cc-brand-50 text-cc-brand-800"
                    : "border border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                }`}
              >
                {isCrew ? "✓ Crew only" : "Restrict to crew"}
              </SubmitButton>
            </form>
          )}
          {!isSelf && (
            <>
              <button
                type="button"
                onClick={() => setResetOpen((v) => !v)}
                disabled={busy}
                className="rounded-lg border border-ppp-charcoal-200 px-2.5 py-1.5 text-[12px] font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 disabled:opacity-60 min-h-[44px] sm:min-h-[36px]"
              >
                Reset password
              </button>
              <button
                type="button"
                onClick={toggleActive}
                disabled={busy}
                className={`rounded-lg px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-60 min-h-[44px] sm:min-h-[36px] touch-manipulation ${
                  user.is_active
                    ? "border border-rose-200 text-rose-700 hover:bg-rose-50"
                    : "border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                }`}
              >
                {user.is_active ? "Deactivate" : "Reactivate"}
              </button>
            </>
          )}
        </div>
      </div>
      {resetOpen && !isSelf && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            aria-label="New password (min 8 characters)"
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
