import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import {
  INPUT_CLS,
  SELECT_CLS,
  SELECT_BG_STYLE,
  TEXTAREA_CLS,
  LABEL_CLS,
} from "@/lib/commercial/form-classnames";

import {
  getOpportunitySubmittal,
  editOpportunitySubmittal,
  deleteOpportunitySubmittal,
} from "@/lib/commercial/opportunities/submittals";
import {
  addSubmittalItem,
  editSubmittalItem,
  deleteSubmittalItem,
} from "@/lib/commercial/opportunities/submittal-items";
import { listOpportunityFinishes } from "@/lib/commercial/opportunities/finishes";
import {
  INCLUDED_KINDS,
  TRANSMITTED_AS_OPTIONS,
  includedKindLabel,
  isTerminalSubmittalStatus,
  submittalStatusLabel,
  submittalStatusTone,
  transmittedAsLabel,
  type IncludedKind,
  type TransmittedAs,
} from "@/lib/commercial/opportunities/submittal-constants";

/**
 * Submittal detail page — `/commercial/opportunities/[id]/submittals/[sid]`.
 *
 * Cover-form editing + items editor. Status transitions (Send / Approve /
 * Revise & resubmit / Void) ship in Batch 4. PDF download + spec-sheet
 * attachment linkage ship in Batch 5/6.
 *
 * Scoping: every server action takes BOTH opportunity_id AND submittal_id,
 * and the lib double-scopes (eq id + eq opportunity_id) on every mutation.
 * Mirror of yesterday's cross-account security fix shape.
 */

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string; sid: string }>;
type SP = Promise<{ error?: string; saved?: string }>;

// ─────────────────────────────────────────────────────────────────────
//  Cover form edit action — draft-only (lib enforces)
// ─────────────────────────────────────────────────────────────────────

async function editCoverAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    redirect("/commercial/opportunities");
  }

  // Collect the 9 "WE ARE SENDING YOU" checkbox values into the included_kinds array.
  const included_kinds: IncludedKind[] = [];
  for (const kind of INCLUDED_KINDS) {
    if (formData.get(`included_${kind}`) === "on") included_kinds.push(kind);
  }

  // transmitted_as = empty string means "no selection" → null
  const transmittedRaw = (formData.get("transmitted_as") as string | null)?.trim() || "";
  const transmitted_as = (transmittedRaw || null) as TransmittedAs | null;

  // Address — textarea with 1 line per entry; split + trim.
  const addressRaw = String(formData.get("to_address") ?? "");
  const to_address_lines = addressRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const result = await editOpportunitySubmittal({
    opportunity_id,
    submittal_id,
    to_company: (formData.get("to_company") as string)?.trim() || null,
    to_attention: (formData.get("to_attention") as string)?.trim() || null,
    to_address_lines: to_address_lines.length > 0 ? to_address_lines : null,
    re_subject: (formData.get("re_subject") as string)?.trim() || "Submittals",
    included_kinds,
    transmitted_as,
    remarks: (formData.get("remarks") as string)?.trim() || null,
    updated_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?saved=1`);
}

// ─────────────────────────────────────────────────────────────────────
//  Item actions — draft-only (lib enforces via loadSubmittalForItemMutation)
// ─────────────────────────────────────────────────────────────────────

async function addItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    redirect("/commercial/opportunities");
  }

  const description = String(formData.get("description") ?? "").trim();
  if (!description) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent("Description is required.")
    );
  }
  const copiesRaw = String(formData.get("copies") ?? "1").trim();
  const copies = parseInt(copiesRaw, 10);
  if (!Number.isFinite(copies) || copies < 1) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent("Copies must be a positive whole number.")
    );
  }

  const result = await addSubmittalItem({
    opportunity_id,
    submittal_id,
    description,
    copies,
    item_date: (formData.get("item_date") as string)?.trim() || null,
    item_number: (formData.get("item_number") as string)?.trim() || null,
    finish_code: (formData.get("finish_code") as string)?.trim() || null,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}`);
}

async function editItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  const item_id = String(formData.get("item_id") ?? "");
  if (![opportunity_id, submittal_id, item_id].every((s) => UUID_RE.test(s))) {
    redirect("/commercial/opportunities");
  }

  const description = String(formData.get("description") ?? "").trim();
  if (!description) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent("Description is required.")
    );
  }
  const copies = parseInt(String(formData.get("copies") ?? "1").trim(), 10);

  const result = await editSubmittalItem({
    opportunity_id,
    submittal_id,
    item_id,
    description,
    copies: Number.isFinite(copies) && copies >= 1 ? copies : 1,
    item_date: (formData.get("item_date") as string)?.trim() || null,
    item_number: (formData.get("item_number") as string)?.trim() || null,
    finish_code: (formData.get("finish_code") as string)?.trim() || null,
    updated_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}`);
}

async function deleteItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  const item_id = String(formData.get("item_id") ?? "");
  if (![opportunity_id, submittal_id, item_id].every((s) => UUID_RE.test(s))) {
    redirect("/commercial/opportunities");
  }
  const result = await deleteSubmittalItem(opportunity_id, submittal_id, item_id, user.id);
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}`);
}

// ─────────────────────────────────────────────────────────────────────
//  Delete submittal (draft only)
// ─────────────────────────────────────────────────────────────────────

async function deleteSubmittalAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    redirect("/commercial/opportunities");
  }
  const result = await deleteOpportunitySubmittal(opportunity_id, submittal_id, user.id);
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  // Drop the badge count on the opp list page.
  revalidatePath("/commercial/opportunities");
  redirect(`/commercial/opportunities/${opportunity_id}?tab=submittals`);
}

// ─────────────────────────────────────────────────────────────────────
//  Page
// ─────────────────────────────────────────────────────────────────────

export default async function SubmittalDetailPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id: opportunity_id, sid: submittal_id } = await params;
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) notFound();

  const sp = await searchParams;
  const errorMessage = pickFirst(sp.error);
  const saved = pickFirst(sp.saved) === "1";

  const loaded = await getOpportunitySubmittal(opportunity_id, submittal_id);
  if (!loaded) notFound();
  const { submittal, items, statusLog } = loaded;

  // Finish-code suggestions for the items editor (autocomplete-friendly).
  const finishes = await listOpportunityFinishes(opportunity_id);

  const isDraft = submittal.status === "draft";
  const isTerminal = isTerminalSubmittalStatus(submittal.status);
  const tone = submittalStatusTone(submittal.status);
  const tonePillCls =
    tone === "emerald" ? "bg-emerald-50 text-emerald-800 border-emerald-200"
    : tone === "amber" ? "bg-amber-50 text-amber-900 border-amber-200"
    : tone === "rose" ? "bg-rose-50 text-rose-800 border-rose-200"
    : tone === "sky" ? "bg-sky-50 text-sky-800 border-sky-200"
    : tone === "charcoal" ? "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200"
    : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200";

  const fmtDate = (iso: string | null): string => {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };
  const fmtDateTime = (iso: string | null): string => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const includedSet = new Set<IncludedKind>(submittal.included_kinds);
  const addressDefault = (submittal.to_address_lines ?? []).join("\n");

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Back link */}
      <Link
        href={`/commercial/opportunities/${opportunity_id}?tab=submittals`}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ppp-charcoal-600 hover:text-ppp-charcoal min-h-[44px] touch-manipulation"
      >
        ← Back to submittals
      </Link>

      {/* Banners */}
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {saved && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>Cover saved.</span>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-ppp-charcoal font-mono">
                SUB-{String(submittal.submittal_number).padStart(3, "0")}
                {submittal.revision_number > 0 && (
                  <span className="text-ppp-charcoal-500 ml-2 text-lg">Rev {submittal.revision_number}</span>
                )}
              </h1>
              <span
                className={`inline-flex items-center text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded border ${tonePillCls}`}
              >
                {submittalStatusLabel(submittal.status)}
              </span>
            </div>
            <div className="text-[12px] text-ppp-charcoal-500 mt-1">
              Created {fmtDateTime(submittal.created_at)}
              {submittal.sent_at && <span> · Sent {fmtDate(submittal.sent_at)}</span>}
              {submittal.response_received_at && (
                <span> · Response received {fmtDate(submittal.response_received_at)}</span>
              )}
            </div>
          </div>

          {/* Draft-only actions: delete */}
          {isDraft && (
            <form action={deleteSubmittalAction}>
              <input type="hidden" name="opportunity_id" value={opportunity_id} />
              <input type="hidden" name="submittal_id" value={submittal_id} />
              <button
                type="submit"
                className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-sm font-semibold text-rose-700 hover:bg-rose-50 min-h-[44px] touch-manipulation"
              >
                Delete draft
              </button>
            </form>
          )}
        </div>

        {/* Status-transition action placeholder — Batch 4 will wire these */}
        {!isTerminal && (
          <div className="mt-4 px-3 py-2 rounded-lg bg-sky-50 border border-sky-100 text-[12px] text-sky-800">
            <strong className="font-semibold">Lifecycle actions coming next:</strong>{" "}
            Send · Mark Approved · Approve as Noted · Request Revision · Void.
            Wire-up lands in Batch 4 of the Submittals phase.
          </div>
        )}
      </header>

      {/* Cover form */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">
          Letter of Transmittal — cover
        </h2>
        {!isDraft && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-[12px] text-amber-900">
            <strong className="font-semibold">Sent.</strong> Cover is locked. To revise content,
            void this submittal and create a new revision.
          </div>
        )}
        <form action={editCoverAction} className="space-y-4">
          <input type="hidden" name="opportunity_id" value={opportunity_id} />
          <input type="hidden" name="submittal_id" value={submittal_id} />

          {/* To / Attention — 2-col on sm+ */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="to_company" className={LABEL_CLS}>To (company)</label>
              <input
                id="to_company"
                name="to_company"
                type="text"
                maxLength={120}
                defaultValue={submittal.to_company ?? ""}
                disabled={!isDraft}
                placeholder="e.g. Alta Construction"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label htmlFor="to_attention" className={LABEL_CLS}>Attention</label>
              <input
                id="to_attention"
                name="to_attention"
                type="text"
                maxLength={120}
                defaultValue={submittal.to_attention ?? ""}
                disabled={!isDraft}
                placeholder="e.g. Meyer Beyda"
                className={INPUT_CLS}
              />
            </div>
          </div>

          {/* Address — textarea, one line per address line */}
          <div>
            <label htmlFor="to_address" className={LABEL_CLS}>Bill-to address</label>
            <textarea
              id="to_address"
              name="to_address"
              rows={3}
              maxLength={400}
              defaultValue={addressDefault}
              disabled={!isDraft}
              placeholder="One line per address line — e.g. 143 W 29th Street Fl 12&#10;New York NY 10001"
              className={TEXTAREA_CLS}
            />
          </div>

          {/* RE */}
          <div>
            <label htmlFor="re_subject" className={LABEL_CLS}>RE</label>
            <input
              id="re_subject"
              name="re_subject"
              type="text"
              maxLength={120}
              defaultValue={submittal.re_subject ?? "Submittals"}
              disabled={!isDraft}
              className={INPUT_CLS}
            />
          </div>

          {/* WE ARE SENDING YOU — 9 checkboxes in a wrap grid */}
          <div>
            <label className={LABEL_CLS}>We are sending you</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
              {INCLUDED_KINDS.map((kind) => (
                <label
                  key={kind}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded border min-h-[44px] touch-manipulation ${
                    isDraft
                      ? "border-ppp-charcoal-200 hover:bg-ppp-charcoal-50 cursor-pointer"
                      : "border-ppp-charcoal-100 bg-ppp-charcoal-50/50 cursor-not-allowed"
                  }`}
                >
                  <input
                    type="checkbox"
                    name={`included_${kind}`}
                    defaultChecked={includedSet.has(kind)}
                    disabled={!isDraft}
                    className="w-4 h-4 rounded border-ppp-charcoal-300 text-emerald-600 focus:ring-emerald-600/40"
                  />
                  <span className="text-[12px] text-ppp-charcoal-700">
                    {includedKindLabel(kind)}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* THESE ARE TRANSMITTED — radio-as-select for compactness */}
          <div>
            <label htmlFor="transmitted_as" className={LABEL_CLS}>These are transmitted</label>
            <select
              id="transmitted_as"
              name="transmitted_as"
              defaultValue={submittal.transmitted_as ?? ""}
              disabled={!isDraft}
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              <option value="">— Select —</option>
              {TRANSMITTED_AS_OPTIONS.map((t) => (
                <option key={t} value={t}>{transmittedAsLabel(t)}</option>
              ))}
            </select>
          </div>

          {/* Remarks */}
          <div>
            <label htmlFor="remarks" className={LABEL_CLS}>Remarks</label>
            <textarea
              id="remarks"
              name="remarks"
              rows={2}
              maxLength={1000}
              defaultValue={submittal.remarks ?? ""}
              disabled={!isDraft}
              placeholder="Optional — handwritten notes from the cover (e.g. &ldquo;Doors will now be pre-finished.&rdquo;)"
              className={TEXTAREA_CLS}
            />
          </div>

          {isDraft && (
            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
              >
                Save cover
              </button>
            </div>
          )}
        </form>
      </section>

      {/* Items table */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">
          Items · {items.length}
        </h2>

        {/* Add item — draft only */}
        {isDraft && (
          <form
            action={addItemAction}
            className="bg-ppp-charcoal-50 border border-ppp-charcoal-100 rounded-lg p-3 mb-4 space-y-3"
          >
            <input type="hidden" name="opportunity_id" value={opportunity_id} />
            <input type="hidden" name="submittal_id" value={submittal_id} />

            {/* Description — full width, required */}
            <div>
              <label className={LABEL_CLS}>
                Description <span className="text-rose-700">*</span>
              </label>
              <input
                name="description"
                type="text"
                required
                maxLength={300}
                placeholder="e.g. Material Spec Sheets"
                className={INPUT_CLS}
              />
            </div>

            {/* Copies / Date / # / Finish — 2-col mobile, 4-col desktop */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className={LABEL_CLS}>Copies</label>
                <input
                  name="copies"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  defaultValue={1}
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LABEL_CLS}>Date</label>
                <input name="item_date" type="date" className={INPUT_CLS} />
              </div>
              <div>
                <label className={LABEL_CLS}>Ref #</label>
                <input
                  name="item_number"
                  type="text"
                  maxLength={32}
                  placeholder="optional"
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LABEL_CLS}>Finish code</label>
                <input
                  name="finish_code"
                  type="text"
                  maxLength={32}
                  list="finish-codes-list"
                  placeholder="e.g. WD-1"
                  className={INPUT_CLS}
                />
              </div>
            </div>

            {/* Datalist powers the finish-code typeahead from the opp's Finish Schedule */}
            <datalist id="finish-codes-list">
              {finishes.map((f) => (
                <option key={f.id} value={f.code}>
                  {f.product_name ? `${f.code} · ${f.product_name}` : f.code}
                </option>
              ))}
            </datalist>

            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 min-h-[44px] touch-manipulation"
              >
                Add item
              </button>
            </div>
          </form>
        )}

        {/* Items list */}
        {items.length === 0 ? (
          <div className="bg-ppp-charcoal-50/50 border border-dashed border-ppp-charcoal-200 rounded-lg p-6 text-center text-[12px] text-ppp-charcoal-500">
            No items yet. {isDraft ? "Add rows for spec sheets, drawdowns, samples, etc." : "Empty submittal — void and recreate."}
          </div>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100 -mx-5">
            {items.map((item) => (
              <li key={item.id} className="px-5 py-3">
                {isDraft ? (
                  <details className="group">
                    <summary className="cursor-pointer list-none flex items-start gap-3 -mx-2 px-2 py-1 rounded hover:bg-ppp-charcoal-50">
                      <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded bg-ppp-charcoal-100 text-ppp-charcoal-700 text-[11px] font-bold font-mono min-w-[2rem] justify-center">
                        ×{item.copies}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-ppp-charcoal break-words">
                          {item.description}
                        </div>
                        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                          {item.item_date && <span>{fmtDate(item.item_date)}</span>}
                          {item.item_date && (item.item_number || item.finish_code) && <span> · </span>}
                          {item.item_number && <span>#{item.item_number}</span>}
                          {item.item_number && item.finish_code && <span> · </span>}
                          {item.finish_code && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 font-mono">
                              {item.finish_code}
                            </span>
                          )}
                        </div>
                      </div>
                      <span aria-hidden className="shrink-0 text-ppp-charcoal-400 text-[12px] mt-1 transition-transform group-open:rotate-90">
                        ▶
                      </span>
                    </summary>

                    <form action={editItemAction} className="mt-3 space-y-3 pl-1">
                      <input type="hidden" name="opportunity_id" value={opportunity_id} />
                      <input type="hidden" name="submittal_id" value={submittal_id} />
                      <input type="hidden" name="item_id" value={item.id} />

                      <div>
                        <label className={LABEL_CLS}>
                          Description <span className="text-rose-700">*</span>
                        </label>
                        <input
                          name="description"
                          type="text"
                          required
                          maxLength={300}
                          defaultValue={item.description}
                          className={INPUT_CLS}
                        />
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div>
                          <label className={LABEL_CLS}>Copies</label>
                          <input
                            name="copies"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            defaultValue={item.copies}
                            className={INPUT_CLS}
                          />
                        </div>
                        <div>
                          <label className={LABEL_CLS}>Date</label>
                          <input
                            name="item_date"
                            type="date"
                            defaultValue={item.item_date ?? ""}
                            className={INPUT_CLS}
                          />
                        </div>
                        <div>
                          <label className={LABEL_CLS}>Ref #</label>
                          <input
                            name="item_number"
                            type="text"
                            maxLength={32}
                            defaultValue={item.item_number ?? ""}
                            className={INPUT_CLS}
                          />
                        </div>
                        <div>
                          <label className={LABEL_CLS}>Finish code</label>
                          <input
                            name="finish_code"
                            type="text"
                            maxLength={32}
                            list="finish-codes-list"
                            defaultValue={item.finish_code ?? ""}
                            className={INPUT_CLS}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="submit"
                          className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 min-h-[44px] touch-manipulation"
                        >
                          Save item
                        </button>
                      </div>
                    </form>

                    {/* Delete is its own form so it doesn't conflict with the edit form */}
                    <form action={deleteItemAction} className="mt-2 pl-1">
                      <input type="hidden" name="opportunity_id" value={opportunity_id} />
                      <input type="hidden" name="submittal_id" value={submittal_id} />
                      <input type="hidden" name="item_id" value={item.id} />
                      <button
                        type="submit"
                        className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-[12px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[36px]"
                      >
                        Delete item
                      </button>
                    </form>
                  </details>
                ) : (
                  // Locked view (non-draft)
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded bg-ppp-charcoal-100 text-ppp-charcoal-700 text-[11px] font-bold font-mono min-w-[2rem] justify-center">
                      ×{item.copies}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-ppp-charcoal break-words">{item.description}</div>
                      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                        {item.item_date && <span>{fmtDate(item.item_date)}</span>}
                        {item.item_date && item.item_number && <span> · </span>}
                        {item.item_number && <span>#{item.item_number}</span>}
                        {item.finish_code && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 font-mono">
                            {item.finish_code}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Spec-sheet attachments — Batch 6 wires this to attachment.submittal_id */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-1">Attached spec sheets &amp; samples</h2>
        <p className="text-[12px] text-ppp-charcoal-500">
          Coming next batch: link uploaded PDFs from{" "}
          <Link
            href={`/commercial/opportunities/${opportunity_id}?tab=plans`}
            className="text-emerald-700 hover:text-emerald-800 underline underline-offset-2"
          >
            Plans &amp; Specs
          </Link>
          {" "}to this specific submittal, and auto-store the generated Letter of Transmittal PDF here.
        </p>
      </section>

      {/* Status timeline */}
      {statusLog.length > 0 && (
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
          <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Status history</h2>
          <ol className="space-y-2">
            {statusLog.map((log) => (
              <li key={log.id} className="text-[12px] text-ppp-charcoal-700 flex items-start gap-2">
                <span className="text-ppp-charcoal-400 mt-0.5">•</span>
                <div className="flex-1">
                  <span className="font-medium">
                    {log.from_status ? `${submittalStatusLabel(log.from_status)} → ` : ""}
                    {submittalStatusLabel(log.to_status)}
                  </span>
                  <span className="text-ppp-charcoal-500 ml-2">{fmtDateTime(log.changed_at)}</span>
                  {log.note && (
                    <div className="text-ppp-charcoal-500 mt-0.5">&ldquo;{log.note}&rdquo;</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
