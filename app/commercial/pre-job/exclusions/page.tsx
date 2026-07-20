/**
 * Phase F.0 Exclusions Library — admin list surface.
 *
 * Katie 2026-07-13: the recurring proposal exclusion phrases (seeded from
 * 5 real Tomco proposals) live here so <ExclusionPicker> in the Proposal
 * Builder can multi-select instead of retyping. Standard rows auto-add to
 * every new proposal; optional rows are hand-picked per proposal.
 *
 * Reads open to any commercial user; writes admin-gated (mirrors Products).
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import {
  listExclusions,
  createExclusion,
  updateExclusion,
  softDeleteExclusion,
} from "@/lib/commercial/exclusions/db";
import {
  EXCLUSION_CATEGORIES,
  exclusionCategoryLabel,
  type ExclusionCategory,
} from "@/lib/commercial/exclusions/constants";
import {
  SELECT_CLS,
  SELECT_BG_STYLE,
  INPUT_CLS,
  LABEL_CLS,
} from "@/lib/commercial/form-classnames";

export const dynamic = "force-dynamic";

async function requireAdmin(): Promise<{ userId: string; isAdmin: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (!access.hasNewPlatform) redirect("/commercial");
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  return { userId: user.id, isAdmin };
}

async function createExclusionAction(formData: FormData) {
  "use server";
  const { userId, isAdmin } = await requireAdmin();
  if (!isAdmin) {
    redirect("/commercial/pre-job/exclusions?error=admins-only");
  }
  const text = String(formData.get("text") ?? "").trim();
  const category = String(formData.get("category") ?? "optional") as ExclusionCategory;
  const result = await createExclusion({
    text,
    category,
    created_by_user_id: userId,
  });
  if (!result.ok) {
    redirect(
      `/commercial/pre-job/exclusions?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath("/commercial/pre-job/exclusions");
  redirect("/commercial/pre-job/exclusions?ok=1");
}

async function updateExclusionAction(formData: FormData) {
  "use server";
  const { userId, isAdmin } = await requireAdmin();
  if (!isAdmin) redirect("/commercial/pre-job/exclusions?error=admins-only");
  const id = String(formData.get("id") ?? "");
  const text = String(formData.get("text") ?? "").trim();
  const category = String(formData.get("category") ?? "optional") as ExclusionCategory;
  const is_active = formData.get("is_active") === "on";
  const result = await updateExclusion({
    id,
    text,
    category,
    is_active,
    updated_by_user_id: userId,
  });
  if (!result.ok) {
    redirect(
      `/commercial/pre-job/exclusions?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath("/commercial/pre-job/exclusions");
  redirect("/commercial/pre-job/exclusions?ok=1");
}

async function deleteExclusionAction(formData: FormData) {
  "use server";
  const { userId, isAdmin } = await requireAdmin();
  if (!isAdmin) redirect("/commercial/pre-job/exclusions?error=admins-only");
  const id = String(formData.get("id") ?? "");
  const result = await softDeleteExclusion(id, userId);
  if (!result.ok) {
    redirect(
      `/commercial/pre-job/exclusions?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath("/commercial/pre-job/exclusions");
  redirect("/commercial/pre-job/exclusions?ok=1&deleted=1");
}

export default async function ExclusionsLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    archived?: string;
    ok?: string;
    error?: string;
    deleted?: string;
    edit?: string;
  }>;
}) {
  const { isAdmin } = await requireAdmin();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const category =
    sp.category && (EXCLUSION_CATEGORIES as readonly string[]).includes(sp.category)
      ? (sp.category as ExclusionCategory)
      : "all";
  const includeInactive = sp.archived === "1";
  const editId = sp.edit ?? null;

  const rows = await listExclusions({
    search: q || undefined,
    category,
    activeOnly: !includeInactive,
  });
  const editing = editId ? rows.find((r) => r.id === editId) ?? null : null;

  const standardCount = rows.filter((r) => r.category === "standard").length;
  const optionalCount = rows.filter((r) => r.category === "optional").length;

  return (
    <div className="space-y-5">
      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
              Exclusions Library
            </h1>
            <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
              {standardCount} standard · {optionalCount} optional
            </span>
          </div>
        </div>
        <p className="text-sm text-ppp-charcoal-600 max-w-2xl">
          Recurring exclusion phrases the Proposal Builder pulls from. Standard rows are auto-added to every new proposal; optional rows are hand-picked per proposal.
        </p>
      </header>

      {sp.ok === "1" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800">
          {sp.deleted === "1" ? "Archived." : "Saved."}
        </div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-800">
          {sp.error === "admins-only"
            ? "Admin access required to edit the Exclusions Library."
            : decodeURIComponent(sp.error)}
        </div>
      )}

      {/* Toolbar */}
      <form
        method="get"
        className="flex flex-wrap items-end gap-3 bg-white border border-ppp-charcoal-100 rounded-xl p-4"
      >
        <label className="flex-1 min-w-[200px]">
          <span className={LABEL_CLS}>Search</span>
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="e.g. sales tax, lift, materials"
            className={INPUT_CLS}
          />
        </label>
        <label>
          <span className={LABEL_CLS}>Category</span>
          <select
            name="category"
            defaultValue={category}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
          >
            <option value="all">All</option>
            {EXCLUSION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {exclusionCategoryLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-2 pb-2">
          <input
            type="checkbox"
            name="archived"
            value="1"
            defaultChecked={includeInactive}
            className="w-4 h-4 accent-cc-brand-600"
          />
          <span className="text-[13px] text-ppp-charcoal-700">Include archived</span>
        </label>
        <button
          type="submit"
          className="inline-flex items-center px-4 py-2 rounded-lg bg-ppp-charcoal-800 text-white text-sm font-semibold hover:bg-ppp-charcoal-900 min-h-[44px]"
        >
          Apply
        </button>
      </form>

      {/* Add / edit form (admin only) */}
      {isAdmin && (
        <form
          action={editing ? updateExclusionAction : createExclusionAction}
          className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 space-y-3"
        >
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-bold text-ppp-charcoal">
              {editing ? `Edit exclusion` : `Add a new exclusion`}
            </h2>
            {editing && (
              <Link
                href="/commercial/pre-job/exclusions"
                className="text-[12px] text-ppp-charcoal-500 hover:text-ppp-charcoal underline"
              >
                Cancel
              </Link>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="sm:col-span-2">
              <span className={LABEL_CLS}>Text</span>
              <input
                type="text"
                name="text"
                required
                maxLength={500}
                defaultValue={editing?.text ?? ""}
                placeholder="e.g. Sales Tax, unless applicable."
                className={INPUT_CLS}
              />
            </label>
            <label>
              <span className={LABEL_CLS}>Category</span>
              <select
                name="category"
                defaultValue={editing?.category ?? "optional"}
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
              >
                {EXCLUSION_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {exclusionCategoryLabel(c)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {editing && (
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                name="is_active"
                defaultChecked={editing.is_active}
                className="w-4 h-4 accent-cc-brand-600"
              />
              <span className="text-[13px] text-ppp-charcoal-700">Active</span>
            </label>
          )}
          <button
            type="submit"
            className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]"
          >
            {editing ? "Save changes" : "Add exclusion"}
          </button>
        </form>
      )}

      {/* Rows */}
      {rows.length === 0 ? (
        <div className="bg-white border border-dashed border-ppp-charcoal-200 rounded-xl p-8 text-center">
          <p className="text-sm text-ppp-charcoal-500">
            {q ? `No exclusions matched "${q}".` : "No exclusions in the library yet."}
          </p>
          {!q && isAdmin && (
            <p className="mt-2 text-[13px] text-ppp-charcoal-500">
              Add the first one above.
            </p>
          )}
        </div>
      ) : (
        <ul className="bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100">
          {rows.map((r) => (
            <li key={r.id} className="px-4 py-3 flex items-center gap-3 hover:bg-ppp-charcoal-50 group">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest shrink-0 border ${
                  r.category === "standard"
                    ? "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200"
                    : "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200"
                }`}
              >
                {exclusionCategoryLabel(r.category)}
              </span>
              <span className="flex-1 text-sm text-ppp-charcoal-800">{r.text}</span>
              {r.use_count > 0 && (
                <span className="text-[11px] text-ppp-charcoal-500 tabular-nums shrink-0">
                  used {r.use_count}×
                </span>
              )}
              {!r.is_active && (
                <span className="text-[11px] text-amber-700 shrink-0">archived</span>
              )}
              {isAdmin && (
                <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Link
                    href={`/commercial/pre-job/exclusions?edit=${r.id}`}
                    className="text-[12px] text-cc-brand-700 hover:text-cc-brand-800 underline"
                  >
                    Edit
                  </Link>
                  <form action={deleteExclusionAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <ConfirmSubmitButton
                      message={`Archive "${r.text.slice(0, 80)}${r.text.length > 80 ? "…" : ""}"? Existing proposals that reference it keep the text on their PDF; new proposals won't be able to pick it.`}
                      pendingLabel="Archiving…"
                      className="text-[12px] text-rose-700 hover:text-rose-800 underline disabled:opacity-50"
                    >
                      Archive
                    </ConfirmSubmitButton>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
