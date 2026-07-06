import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  listAllCompetitors,
  renameCompetitor,
  setCompetitorActive,
  mergeCompetitor,
  getOrCreateCompetitor,
} from "@/lib/commercial/competitors";

/**
 * Competitors admin — manage the typeahead dictionary backing the Win/Loss
 * Debrief modal. Admin-only.
 *
 * Operations:
 *   - Add a new competitor (free-text, normalized lookup auto-creates if missing)
 *   - Rename (typo fix, rebrand)
 *   - Retire (mark inactive — historic debriefs preserved via FK)
 *   - Merge — fold one row into another so reports roll up cleanly
 *
 * Mobile: table → card grid on small screens.
 */

export const dynamic = "force-dynamic";

async function addAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/commercial/settings/competitors?error=name");
  const result = await getOrCreateCompetitor(name, user.id);
  if (!result.ok) {
    redirect("/commercial/settings/competitors?error=" + encodeURIComponent(result.error));
  }
  redirect("/commercial/settings/competitors?ok=added");
}

async function renameAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  const id = String(formData.get("id") ?? "");
  const newName = String(formData.get("name") ?? "").trim();
  if (!id || !newName) redirect("/commercial/settings/competitors?error=invalid");
  const result = await renameCompetitor(id, newName, user.id);
  if (!result.ok) {
    redirect("/commercial/settings/competitors?error=" + encodeURIComponent(result.error));
  }
  redirect("/commercial/settings/competitors?ok=renamed");
}

async function toggleActiveAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  const id = String(formData.get("id") ?? "");
  const setTo = String(formData.get("set_to") ?? "");
  if (!id) redirect("/commercial/settings/competitors?error=invalid");
  const result = await setCompetitorActive(id, setTo === "active", user.id);
  if (!result.ok) {
    redirect("/commercial/settings/competitors?error=" + encodeURIComponent(result.error));
  }
  redirect("/commercial/settings/competitors?ok=updated");
}

async function mergeAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  const sourceId = String(formData.get("source_id") ?? "");
  const targetId = String(formData.get("target_id") ?? "");
  if (!sourceId || !targetId) redirect("/commercial/settings/competitors?error=invalid");
  const result = await mergeCompetitor(sourceId, targetId, user.id);
  if (!result.ok) {
    redirect("/commercial/settings/competitors?error=" + encodeURIComponent(result.error));
  }
  redirect("/commercial/settings/competitors?ok=merged");
}

export default async function CompetitorsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");

  const sp = await searchParams;
  const competitors = await listAllCompetitors();
  const active = competitors.filter((c) => c.is_active && !c.merged_into_competitor_id);
  const inactive = competitors.filter((c) => !c.is_active && !c.merged_into_competitor_id);
  const merged = competitors.filter((c) => !!c.merged_into_competitor_id);

  return (
    <div className="space-y-5">
      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
            Competitors
          </h1>
          <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
            {active.length} active
          </span>
        </div>
        <p className="text-sm text-ppp-charcoal-500">
          The dictionary that fuels the Win/Loss Debrief typeahead. Rename typos, retire competitors who&apos;ve left the market, merge duplicates so reports aggregate correctly.
        </p>
      </header>

      {sp.ok && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 text-sm text-blue-800">
          {sp.ok === "added" && "Competitor added."}
          {sp.ok === "renamed" && "Competitor renamed."}
          {sp.ok === "updated" && "Competitor status updated."}
          {sp.ok === "merged" && "Competitors merged."}
        </div>
      )}
      {sp.error && (
        <div className="mb-4 bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-sm text-rose-800">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      {/* Add new */}
      <section className="mb-6 bg-white border border-ppp-charcoal-100 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ppp-charcoal mb-3">
          Add a competitor
        </h2>
        <form action={addAction} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            name="name"
            placeholder="e.g. ABC Painting"
            required
            maxLength={200}
            className="flex-1 px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]"
          >
            Add
          </button>
        </form>
        <p className="text-[11px] text-ppp-charcoal-400 mt-2">
          The Win/Loss Debrief typeahead can also add new competitors inline —
          this page is for cleanup + admin tasks (rename, retire, merge).
        </p>
      </section>

      {/* Active competitors */}
      <section className="mb-6 bg-white border border-ppp-charcoal-100 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ppp-charcoal mb-3">
          Active ({active.length})
        </h2>
        {active.length === 0 ? (
          <p className="text-sm text-ppp-charcoal-500">
            No active competitors yet. As debriefs roll in, this list grows.
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((c) => (
              <li key={c.id} className="border border-ppp-charcoal-100 rounded-lg p-3 sm:p-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-ppp-charcoal truncate">{c.name}</div>
                    <div className="text-[11px] text-ppp-charcoal-400 mt-0.5">
                      Added {new Date(c.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <RenameForm competitorId={c.id} currentName={c.name} />
                    <form action={toggleActiveAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="set_to" value="inactive" />
                      <button
                        type="submit"
                        className="text-xs font-medium px-3 py-2 rounded-md border border-amber-200 text-amber-800 hover:bg-amber-50 min-h-[44px]"
                      >
                        Retire
                      </button>
                    </form>
                    <MergeForm sourceId={c.id} sourceName={c.name} candidates={active.filter((x) => x.id !== c.id)} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {inactive.length > 0 && (
        <section className="mb-6 bg-white border border-ppp-charcoal-100 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-ppp-charcoal mb-3">
            Retired ({inactive.length})
          </h2>
          <ul className="space-y-2">
            {inactive.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 border border-ppp-charcoal-100 rounded-lg p-3">
                <span className="text-sm text-ppp-charcoal-500 truncate">{c.name}</span>
                <form action={toggleActiveAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="set_to" value="active" />
                  <button
                    type="submit"
                    className="text-xs font-medium px-3 py-2 rounded-md border border-blue-200 text-blue-800 hover:bg-blue-50 min-h-[44px]"
                  >
                    Reactivate
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {merged.length > 0 && (
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-ppp-charcoal mb-3">
            Merged ({merged.length})
          </h2>
          <ul className="space-y-1">
            {merged.map((c) => {
              const target = competitors.find((x) => x.id === c.merged_into_competitor_id);
              return (
                <li key={c.id} className="text-[12px] text-ppp-charcoal-500">
                  <span className="line-through">{c.name}</span>
                  {" → "}
                  <span className="font-medium text-ppp-charcoal">{target?.name ?? "(unknown)"}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function RenameForm({ competitorId, currentName }: { competitorId: string; currentName: string }) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none text-xs font-medium px-3 py-2 rounded-md border border-ppp-charcoal-200 text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] inline-flex items-center select-none">
        Rename
      </summary>
      <form action={renameAction} className="absolute z-10 right-0 mt-1 bg-white border border-ppp-charcoal-200 rounded-lg shadow-lg p-3 w-64 max-w-[calc(100vw-2rem)] flex gap-2">
        <input type="hidden" name="id" value={competitorId} />
        <input
          type="text"
          name="name"
          defaultValue={currentName}
          required
          maxLength={200}
          className="flex-1 min-w-0 px-2 py-1.5 rounded border border-ppp-charcoal-200 text-base sm:text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
        />
        <button
          type="submit"
          className="text-xs font-semibold px-3 py-1.5 rounded bg-cc-brand-600 text-white hover:bg-cc-brand-700"
        >
          Save
        </button>
      </form>
    </details>
  );
}

function MergeForm({
  sourceId,
  sourceName,
  candidates,
}: {
  sourceId: string;
  sourceName: string;
  candidates: Array<{ id: string; name: string }>;
}) {
  if (candidates.length === 0) return null;
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none text-xs font-medium px-3 py-2 rounded-md border border-rose-200 text-rose-800 hover:bg-rose-50 min-h-[44px] inline-flex items-center select-none">
        Merge
      </summary>
      <form action={mergeAction} className="absolute z-10 right-0 mt-1 bg-white border border-ppp-charcoal-200 rounded-lg shadow-lg p-3 w-72 max-w-[calc(100vw-2rem)]">
        <input type="hidden" name="source_id" value={sourceId} />
        <p className="text-[11px] text-ppp-charcoal-500 mb-2">
          Merge <strong>{sourceName}</strong> into another competitor. All historic debriefs will roll up to the target.
        </p>
        <select
          name="target_id"
          required
          defaultValue=""
          className="block w-full px-2 py-1.5 rounded border border-ppp-charcoal-200 text-base sm:text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
        >
          <option value="" disabled>Pick target…</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <button
          type="submit"
          className="mt-2 w-full text-xs font-semibold px-3 py-2 rounded bg-rose-600 text-white hover:bg-rose-700 min-h-[44px]"
        >
          Merge
        </button>
      </form>
    </details>
  );
}
