"use client";

import { useState } from "react";
import { SELECT_CLS, SELECT_BG_STYLE, LABEL_CLS } from "@/lib/commercial/form-classnames";
import {
  ASSIGNMENT_ROLES,
  assignmentRoleLabel,
  type AssignmentRole,
} from "@/lib/commercial/accounts/assignments";

/**
 * Team-on-create picker for the new-account form.
 *
 * Karan's ask: when creating an account, surface the PPP staff who'll
 * be managing it RIGHT THERE in the create form — don't make the user
 * create-then-navigate-then-add. Once Resend is fully configured, the
 * existing `notifyAssignment()` pipeline (in lib/commercial/accounts/
 * assignments.ts) emails each assigned worker with a link to the new
 * account.
 *
 * Pattern:
 *   - Empty by default (no rows). User clicks "Add a team member" to
 *     start. Optional — an account with zero team members at create-
 *     time is still valid; they get added later via the Team tab.
 *   - Each row: PPP staff dropdown (filtered to has_new_platform_access
 *     + is_active) + role picker + primary checkbox.
 *   - Hidden inputs `team_user_id_<i>`, `team_role_<i>`,
 *     `team_is_primary_<i>` so the server action can iterate.
 *   - `team_count` hidden input tells the server how many rows to read.
 *
 * Mobile:
 *   - 44px min-h on every control + remove button.
 *   - Selects use the shared form-classnames so the inline-SVG chevron
 *     + emerald focus ring match the rest of the form.
 */

type StaffOption = { user_id: string; email: string; full_name: string | null };

// Mirrors the server-side cap in app/commercial/accounts/new/page.tsx
// createAction. Keep these in sync — bump both if Alex ever needs more.
const MAX_TEAM_ROWS = 20;

export default function CommercialNewAccountTeamPicker({
  assignableStaff,
}: {
  assignableStaff: StaffOption[];
}) {
  type Row = { id: number; user_id: string; role: AssignmentRole; is_primary: boolean };
  const [rows, setRows] = useState<Row[]>([]);
  const [nextId, setNextId] = useState(1);

  const addRow = () => {
    if (rows.length >= MAX_TEAM_ROWS) return;
    setRows((r) => [...r, { id: nextId, user_id: "", role: "sales_rep", is_primary: false }]);
    setNextId((n) => n + 1);
  };
  const removeRow = (id: number) => setRows((r) => r.filter((row) => row.id !== id));
  const updateRow = (id: number, patch: Partial<Row>) =>
    setRows((r) => r.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  // Track which (user, role) pairs are already picked. The lib's unique
  // constraint is on (account_id, user_id, role) — so Alice CAN be on the
  // team as both Sales Rep AND Project Manager. The picker should only
  // dim her out for the role(s) she's already been added to, not block
  // her entirely. Primary toggling can still happen on the Team tab.
  const pickedKeys = new Set(
    rows.map((r) => (r.user_id ? `${r.user_id}__${r.role}` : "")).filter(Boolean)
  );

  if (assignableStaff.length === 0) {
    return (
      <div className="text-[12px] text-ppp-charcoal-500 italic">
        No PPP staff have Commercial Command Center access yet. Add team members from
        the Team tab once an admin grants access on the Users page.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input type="hidden" name="team_count" value={rows.length} />

      {rows.length === 0 ? (
        <p className="text-[12px] text-ppp-charcoal-500">
          Optional — add the people who&apos;ll be managing this account so they get
          notified right away. You can also add or change the team later.
        </p>
      ) : null}

      {rows.map((row, idx) => {
        const pickedStaff = row.user_id
          ? assignableStaff.find((s) => s.user_id === row.user_id)
          : null;
        const displayName = pickedStaff
          ? pickedStaff.full_name || pickedStaff.email
          : null;
        const initial = displayName ? displayName.trim().charAt(0).toUpperCase() : "?";
        return (
        <div
          key={row.id}
          className="border border-ppp-charcoal-100 rounded-xl p-3 sm:p-4 bg-ppp-charcoal-50/40 space-y-3"
        >
          <input type="hidden" name={`team_user_id_${idx}`} value={row.user_id} />
          <input type="hidden" name={`team_role_${idx}`} value={row.role} />
          <input
            type="hidden"
            name={`team_is_primary_${idx}`}
            value={row.is_primary ? "1" : "0"}
          />

          {/* Role-tag header strip — shows the picked person + their
              role as a visible pill (★ when primary). Matches the
              pattern from the Team tab on the detail page so the
              picker reads consistent with the live team list. */}
          {pickedStaff && (
            <div className="flex items-center gap-2.5 -mt-1">
              <span
                className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-emerald-100 text-emerald-700 text-sm font-bold shrink-0"
                aria-hidden
              >
                {initial}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ppp-charcoal truncate">
                  {displayName}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  {row.is_primary ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-600 text-white border-emerald-700">
                      ★ {assignmentRoleLabel(row.role)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                      {assignmentRoleLabel(row.role)}
                    </span>
                  )}
                  {pickedStaff.email !== displayName && (
                    <span className="text-[11px] text-ppp-charcoal-500 truncate">
                      {pickedStaff.email}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>PPP Staff *</label>
              <select
                value={row.user_id}
                onChange={(e) => updateRow(row.id, { user_id: e.target.value })}
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
                aria-label={`Team member ${idx + 1} staff picker`}
              >
                <option value="" disabled>
                  Pick someone…
                </option>
                {assignableStaff.map((s) => {
                  const label = s.full_name ? `${s.full_name} (${s.email})` : s.email;
                  // Dim only if this exact (user, role) pair is already
                  // claimed by a DIFFERENT row. Same user in a different
                  // role is allowed.
                  const taken =
                    pickedKeys.has(`${s.user_id}__${row.role}`) && s.user_id !== row.user_id;
                  return (
                    <option key={s.user_id} value={s.user_id} disabled={taken}>
                      {label}
                      {taken ? ` — already on the team as ${assignmentRoleLabel(row.role)}` : ""}
                    </option>
                  );
                })}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Role</label>
              <select
                value={row.role}
                onChange={(e) =>
                  updateRow(row.id, { role: e.target.value as AssignmentRole })
                }
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
                aria-label={`Team member ${idx + 1} role picker`}
              >
                {ASSIGNMENT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {assignmentRoleLabel(r)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <label className="inline-flex items-center gap-2 text-sm text-ppp-charcoal-700 min-h-[44px] touch-manipulation">
              <input
                type="checkbox"
                checked={row.is_primary}
                onChange={(e) => updateRow(row.id, { is_primary: e.target.checked })}
                className="h-4 w-4 rounded border-ppp-charcoal-300 focus:ring-emerald-600/30"
              />
              Mark as primary <span className="text-ppp-charcoal-500">({assignmentRoleLabel(row.role)})</span>
            </label>
            <button
              type="button"
              onClick={() => removeRow(row.id)}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[44px] sm:min-h-0 touch-manipulation"
              aria-label={`Remove team member ${idx + 1}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6 6 18 M6 6l12 12" />
              </svg>
              Remove
            </button>
          </div>
        </div>
        );
      })}

      <button
        type="button"
        onClick={addRow}
        disabled={rows.length >= MAX_TEAM_ROWS}
        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border-2 border-dashed border-emerald-300 bg-emerald-50/40 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 hover:border-emerald-400 min-h-[44px] touch-manipulation transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-50/40 disabled:hover:border-emerald-300"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14 M5 12h14" />
        </svg>
        {rows.length === 0 ? "Add a team member" : "Add another team member"}
      </button>
      {rows.length >= MAX_TEAM_ROWS && (
        <p className="text-[11px] text-amber-700 mt-1">
          Hit the {MAX_TEAM_ROWS}-person cap. Add the rest from the Team tab after this account is created.
        </p>
      )}
    </div>
  );
}
