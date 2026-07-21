import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  listCommercialOpportunities,
  derivedOppName,
  formatOpportunityNumber,
  unarchiveOpportunity,
  opportunityStatusLabel,
} from "@/lib/commercial/opportunities/db";
import { listCommercialAccounts } from "@/lib/commercial/accounts/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";

/**
 * Commercial CC · Archived deals — admin-only bulk-unarchive surface.
 *
 * Lists every archived opportunity (Phase G Q3, migration 067) so an
 * admin can restore rows that were archived by mistake without visiting
 * each account page. Rows show account, deal name/number, status at
 * archive time, and archived_at timestamp. Multi-select checkbox +
 * "Unarchive selected" button; also a per-row inline Unarchive for the
 * single-restore case.
 *
 * Same admin gate as /commercial/settings/health + /competitors.
 */

export const dynamic = "force-dynamic";

async function unarchiveManyAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");

  // FormData.getAll returns every value for a repeated field. Filter
  // for well-formed UUIDs so a malformed payload can't leak into the
  // WHERE clause of the update.
  const rawIds = formData.getAll("id").map((v) => String(v));
  const ids = Array.from(new Set(rawIds.filter((s) => UUID_RE.test(s))));
  if (ids.length === 0) {
    redirect("/commercial/settings/archived?error=none_selected");
  }
  let ok = 0;
  let failed = 0;
  for (const id of ids) {
    const r = await unarchiveOpportunity(id, user.id);
    if (r.ok) ok += 1;
    else failed += 1;
  }
  const qs = new URLSearchParams({ ok: String(ok) });
  if (failed > 0) qs.set("failed", String(failed));
  redirect(`/commercial/settings/archived?${qs.toString()}`);
}

async function unarchiveOneAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) {
    redirect("/commercial/settings/archived?error=invalid_id");
  }
  const result = await unarchiveOpportunity(id, user.id);
  if (!result.ok) {
    redirect(`/commercial/settings/archived?error=${encodeURIComponent(result.error)}`);
  }
  redirect("/commercial/settings/archived?ok=1");
}

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function ArchivedDealsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");

  const sp = await searchParams;
  const okCount = Number(pickFirst(sp.ok) ?? 0);
  const failedCount = Number(pickFirst(sp.failed) ?? 0);
  const errorRaw = pickFirst(sp.error);

  // Pull every archived opp (across every account). No pagination for
  // MVP — archived rows should be a small set; if that changes we add
  // server-side pagination.
  const [archived, accounts] = await Promise.all([
    listCommercialOpportunities({ onlyArchived: true }),
    listCommercialAccounts({}),
  ]);
  const accountNameById = new Map(accounts.map((a) => [a.id, a.company_name]));

  const errorLabel =
    errorRaw === "none_selected"
      ? "Select at least one deal to unarchive."
      : errorRaw === "invalid_id"
      ? "That deal id was malformed. Refresh and try again."
      : errorRaw ?? null;

  return (
    <div className="space-y-5">
      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
            Archived deals
          </h1>
          <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
            Admin
          </span>
        </div>
        <p className="text-sm text-ppp-charcoal-500">
          Every deal currently hidden from the active pipeline. Bulk-select and
          restore any that were archived by mistake. Proposals + invoices tied
          to a deal stay visible even while archived — restoring only affects
          pipeline visibility.
        </p>
      </header>

      {(okCount > 0 || failedCount > 0) && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {okCount > 0 && (
            <>Restored {okCount} deal{okCount === 1 ? "" : "s"} to the active pipeline.</>
          )}
          {failedCount > 0 && (
            <span className="ml-2 text-rose-700">
              ({failedCount} failed — check server logs.)
            </span>
          )}
        </div>
      )}
      {errorLabel && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {errorLabel}
        </div>
      )}

      {archived.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ppp-charcoal-200 bg-ppp-charcoal-50 p-8 text-center">
          <p className="text-sm font-medium text-ppp-charcoal">No archived opportunities.</p>
          <p className="mt-1 text-xs text-ppp-charcoal-500">
            When someone archives a deal from its detail page it lands here for
            bulk restore.
          </p>
        </div>
      ) : (
        <form action={unarchiveManyAction} className="space-y-3">
          {/* Bulk toolbar — sticky so it stays visible on long lists. */}
          <div className="sticky top-0 z-10 -mx-4 sm:mx-0 bg-white/95 backdrop-blur px-4 sm:px-3 py-2 border-y sm:border sm:rounded-lg border-ppp-charcoal-100 flex items-center justify-between gap-3">
            <span className="text-xs text-ppp-charcoal-500">
              {archived.length} archived deal{archived.length === 1 ? "" : "s"}
            </span>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-cc-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cc-brand-700 active:bg-cc-brand-800 focus:outline-none focus:ring-2 focus:ring-cc-brand-500 focus:ring-offset-2 disabled:opacity-50"
            >
              Unarchive selected
            </button>
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block rounded-lg border border-ppp-charcoal-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ppp-charcoal-50 text-left text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-500">
                <tr>
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">Opportunity</th>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Archived</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ppp-charcoal-100">
                {archived.map((o) => {
                  const accountName = accountNameById.get(o.account_id) ?? null;
                  const display = derivedOppName(o, accountName);
                  const oppCode = formatOpportunityNumber(o.project_number);
                  const archivedAt = o.archived_at
                    ? new Date(o.archived_at).toLocaleDateString("en-US", {
                        timeZone: "America/New_York",
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })
                    : "—";
                  return (
                    <tr key={o.id} className="hover:bg-ppp-charcoal-50">
                      <td className="px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          name="id"
                          value={o.id}
                          aria-label={`Select ${display}`}
                          className="h-4 w-4 rounded border-ppp-charcoal-300 text-cc-brand-600 focus:ring-cc-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium text-ppp-charcoal">
                          <Link
                            href={`/commercial/accounts/${o.account_id}?tab=deals&deal=${o.id}#deal-${o.id}`}
                            className="hover:text-cc-brand-700 hover:underline"
                          >
                            {display}
                          </Link>
                        </div>
                        {oppCode && (
                          <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 font-mono">
                            {oppCode}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-ppp-charcoal-600">
                        {accountName ?? "—"}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className="inline-flex items-center rounded bg-ppp-charcoal-100 px-1.5 py-0.5 text-[11px] font-medium text-ppp-charcoal-700">
                          {opportunityStatusLabel(o.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top text-ppp-charcoal-500 whitespace-nowrap">
                        {archivedAt}
                      </td>
                      <td className="px-3 py-2 align-top text-right">
                        {/* Sibling form — keeps its `id` payload out of
                            the surrounding bulk form so a per-row click
                            doesn't accidentally unarchive whatever else
                            is checked. */}
                        <button
                          type="submit"
                          form={`unarchive-one-${o.id}`}
                          className="inline-flex items-center rounded border border-ppp-charcoal-200 px-2 py-1 text-xs font-medium text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                        >
                          Unarchive
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden space-y-2">
            {archived.map((o) => {
              const accountName = accountNameById.get(o.account_id) ?? null;
              const display = derivedOppName(o, accountName);
              const oppCode = formatOpportunityNumber(o.project_number);
              const archivedAt = o.archived_at
                ? new Date(o.archived_at).toLocaleDateString("en-US", {
                    timeZone: "America/New_York",
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })
                : "—";
              return (
                <label
                  key={o.id}
                  className="flex items-start gap-3 rounded-lg border border-ppp-charcoal-100 bg-white p-3"
                >
                  <input
                    type="checkbox"
                    name="id"
                    value={o.id}
                    aria-label={`Select ${display}`}
                    className="mt-1 h-4 w-4 rounded border-ppp-charcoal-300 text-cc-brand-600 focus:ring-cc-brand-500"
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/commercial/accounts/${o.account_id}?tab=deals&deal=${o.id}#deal-${o.id}`}
                      className="font-medium text-ppp-charcoal hover:text-cc-brand-700 hover:underline block truncate"
                    >
                      {display}
                    </Link>
                    <div className="mt-0.5 text-xs text-ppp-charcoal-500 truncate">
                      {accountName ?? "—"}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-ppp-charcoal-500 flex-wrap">
                      {oppCode && <span className="font-mono">{oppCode}</span>}
                      <span className="inline-flex items-center rounded bg-ppp-charcoal-100 px-1.5 py-0.5 font-medium text-ppp-charcoal-700">
                        {opportunityStatusLabel(o.status)}
                      </span>
                      <span>Archived {archivedAt}</span>
                    </div>
                    <button
                      type="submit"
                      form={`unarchive-one-${o.id}`}
                      className="mt-2 inline-flex items-center rounded border border-ppp-charcoal-200 px-2 py-1 text-xs font-medium text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                    >
                      Unarchive
                    </button>
                  </div>
                </label>
              );
            })}
          </div>
        </form>
      )}

      {/* Sibling per-row forms — each carries a single hidden id and
          fires unarchiveOneAction when the row's Unarchive button
          (form={`unarchive-one-${id}`}) submits it. Kept outside the
          bulk form so nested-form is avoided and the two flows can't
          leak FormData into each other. */}
      {archived.map((o) => (
        <form key={`f-${o.id}`} id={`unarchive-one-${o.id}`} action={unarchiveOneAction} className="hidden">
          <input type="hidden" name="id" value={o.id} />
        </form>
      ))}
    </div>
  );
}
