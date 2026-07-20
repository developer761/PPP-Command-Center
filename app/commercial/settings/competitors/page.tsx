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
  getLifetimeCompetitorStats,
  updateCompetitorIntel,
  type CompetitorLifetimeStats,
  type Competitor,
} from "@/lib/commercial/competitors";
import { opportunityLossReasonLabel, type OpportunityLossReason, OPPORTUNITY_LOSS_REASONS } from "@/lib/commercial/opportunities/db";
import Link from "next/link";

function formatCentsCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0";
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars).toLocaleString()}`;
}

function factorLabel(raw: string | null): string {
  if (!raw) return "—";
  if ((OPPORTUNITY_LOSS_REASONS as readonly string[]).includes(raw)) {
    return opportunityLossReasonLabel(raw as OpportunityLossReason);
  }
  return raw;
}

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

function parseDollarsToCents(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = Number(trimmed.replace(/[$,]/g, ""));
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

async function updateIntelAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/commercial/settings/competitors?error=invalid");
  const bidLow = parseDollarsToCents(formData.get("bid_low")?.toString() ?? null);
  const bidHigh = parseDollarsToCents(formData.get("bid_high")?.toString() ?? null);
  const result = await updateCompetitorIntel(
    id,
    {
      website: String(formData.get("website") ?? "").trim() || null,
      home_base: String(formData.get("home_base") ?? "").trim() || null,
      typical_bid_low_cents: bidLow,
      typical_bid_high_cents: bidHigh,
      strengths: String(formData.get("strengths") ?? "").trim() || null,
      weaknesses: String(formData.get("weaknesses") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    },
    user.id
  );
  if (!result.ok) {
    redirect("/commercial/settings/competitors?error=" + encodeURIComponent(result.error));
  }
  redirect("/commercial/settings/competitors?ok=intel_saved");
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
  const [competitors, statsById] = await Promise.all([
    listAllCompetitors(),
    getLifetimeCompetitorStats(),
  ]);
  const activeUnsorted = competitors.filter((c) => c.is_active && !c.merged_into_competitor_id);
  const inactive = competitors.filter((c) => !c.is_active && !c.merged_into_competitor_id);
  const merged = competitors.filter((c) => !!c.merged_into_competitor_id);
  // Karan 2026-07-09: sort active by "lost to us the most" first — that's
  // the operational reading: which shops beat us and how often. Falls
  // back to total encounters, then alphabetical.
  const active = [...activeUnsorted].sort((a, b) => {
    const sa = statsById.get(a.id);
    const sb = statsById.get(b.id);
    const lostA = sa?.lost_count ?? 0;
    const lostB = sb?.lost_count ?? 0;
    if (lostA !== lostB) return lostB - lostA;
    const totA = sa?.total_count ?? 0;
    const totB = sb?.total_count ?? 0;
    if (totA !== totB) return totB - totA;
    return a.name.localeCompare(b.name);
  });

  // Top-of-page summary numbers.
  const totalDebriefs = Array.from(statsById.values()).reduce((s, x) => s + x.total_count, 0);
  const totalLosses = Array.from(statsById.values()).reduce((s, x) => s + x.lost_count, 0);
  const totalWins = Array.from(statsById.values()).reduce((s, x) => s + x.won_count, 0);
  const totalDollarLost = Array.from(statsById.values()).reduce((s, x) => s + x.dollar_lost_cents, 0);
  const overallWinRate = totalWins + totalLosses > 0
    ? Math.round((totalWins / (totalWins + totalLosses)) * 100)
    : null;
  const topRival = active.find((c) => (statsById.get(c.id)?.lost_count ?? 0) > 0) ?? null;

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
        <div className="mb-4 bg-cc-brand-50 border border-cc-brand-200 rounded-xl px-4 py-2.5 text-sm text-cc-brand-800">
          {sp.ok === "added" && "Competitor added."}
          {sp.ok === "renamed" && "Competitor renamed."}
          {sp.ok === "updated" && "Competitor status updated."}
          {sp.ok === "merged" && "Competitors merged."}
          {sp.ok === "intel_saved" && "Intel updated."}
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

      {/* Karan 2026-07-09: intelligence strip. Turns this from a
          dictionary editor into a real "who are we losing to" surface. */}
      {totalDebriefs > 0 && (
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <StatTile label="Head-to-heads" value={String(totalWins + totalLosses)} sub={`${totalDebriefs} debriefs total`} />
          <StatTile label="Win rate" value={overallWinRate !== null ? `${overallWinRate}%` : "—"} sub={`${totalWins} won · ${totalLosses} lost`} tone={overallWinRate !== null && overallWinRate >= 50 ? "good" : "bad"} />
          <StatTile
            label="$ lost to rivals"
            value={totalDollarLost > 0 ? formatCentsCompact(totalDollarLost) : "$0"}
            sub={totalDollarLost > 0 ? "sum of midpoint bids on lost deals" : "no bid-value on any loss yet"}
            tone={totalDollarLost > 0 ? "bad" : undefined}
          />
          <StatTile label="Top rival" value={topRival?.name ?? "—"} sub={topRival ? `${statsById.get(topRival.id)?.lost_count ?? 0} losses to them` : "no losses yet"} tone="bad" />
        </section>
      )}

      {/* Active competitors */}
      <section className="mb-6 bg-white border border-ppp-charcoal-100 rounded-xl p-4">
        <div className="flex items-baseline justify-between mb-3 gap-3">
          <h2 className="text-sm font-semibold text-ppp-charcoal">
            Active ({active.length})
          </h2>
          <span className="text-[11px] text-ppp-charcoal-400">
            Sorted by losses first — the shops beating us most float to the top.
          </span>
        </div>
        {active.length === 0 ? (
          <p className="text-sm text-ppp-charcoal-500">
            No active competitors yet. As debriefs roll in, this list grows.
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((c) => {
              const stats = statsById.get(c.id);
              return (
                <li key={c.id} className="border border-ppp-charcoal-100 rounded-lg p-3 sm:p-4">
                  <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <div className="font-semibold text-[14px] text-ppp-charcoal truncate">{c.name}</div>
                        {stats && stats.win_rate_pct !== null && (
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-bold ${
                              stats.win_rate_pct >= 50
                                ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                                : stats.win_rate_pct === 0
                                ? "bg-rose-50 text-rose-800 border border-rose-200"
                                : "bg-amber-50 text-amber-800 border border-amber-200"
                            }`}
                            title={`${stats.won_count} won · ${stats.lost_count} lost head-to-head`}
                          >
                            {stats.win_rate_pct}% win rate
                          </span>
                        )}
                      </div>
                      {stats && stats.total_count > 0 ? (
                        <>
                          <div className="text-[11.5px] text-ppp-charcoal-600 mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap tabular-nums">
                            <span><strong className="text-ppp-charcoal">{stats.won_count}</strong> won</span>
                            <span aria-hidden className="text-ppp-charcoal-300">·</span>
                            <span><strong className={stats.lost_count > 0 ? "text-rose-700" : "text-ppp-charcoal"}>{stats.lost_count}</strong> lost</span>
                            {stats.no_bid_count > 0 && (
                              <>
                                <span aria-hidden className="text-ppp-charcoal-300">·</span>
                                <span>{stats.no_bid_count} no-bid</span>
                              </>
                            )}
                            {stats.dollar_lost_cents > 0 && (
                              <>
                                <span aria-hidden className="text-ppp-charcoal-300">·</span>
                                <span className="text-rose-700">
                                  <strong>{formatCentsCompact(stats.dollar_lost_cents)}</strong> lost to them
                                </span>
                              </>
                            )}
                            {stats.last_seen_at && (
                              <>
                                <span aria-hidden className="text-ppp-charcoal-300">·</span>
                                <span className="text-ppp-charcoal-500">
                                  Last seen {new Date(stats.last_seen_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                </span>
                              </>
                            )}
                          </div>
                          {stats.top_deciding_factor && (
                            <div className="text-[11px] text-ppp-charcoal-500 mt-1">
                              Losing on <strong className="text-ppp-charcoal-700">{factorLabel(stats.top_deciding_factor)}</strong> most often
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-[11.5px] text-ppp-charcoal-500 mt-1 italic">
                          Not seen on any debrief yet.
                        </div>
                      )}
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
                  <IntelEditor competitor={c} />
                </li>
              );
            })}
          </ul>
        )}
        {totalDebriefs > 0 && (
          <div className="mt-3 pt-3 border-t border-ppp-charcoal-100 text-[11.5px] text-ppp-charcoal-500 flex items-center gap-1">
            <span>Stats come from Win/Loss Debriefs.</span>
            <Link href="/commercial/reports/win-loss" className="text-cc-brand-700 font-semibold hover:underline">
              Open the full report →
            </Link>
          </div>
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
                    className="text-xs font-medium px-3 py-2 rounded-md border border-cc-brand-200 text-cc-brand-800 hover:bg-cc-brand-50 min-h-[44px]"
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

/** Karan 2026-07-09: admin-editable intel below each active competitor.
 *  Collapsed by default when there's data (surface a summary line);
 *  open by default when the row is bare so Alex sees where to fill in.
 *  Fields: website, home base, typical bid range (low/high $), what
 *  they're good at, where they're weak, general notes. */
function IntelEditor({ competitor }: { competitor: Competitor }) {
  const hasIntel = !!(
    competitor.website ||
    competitor.home_base ||
    competitor.typical_bid_low_cents !== null ||
    competitor.typical_bid_high_cents !== null ||
    competitor.strengths ||
    competitor.weaknesses ||
    competitor.notes
  );
  const dollarStr = (cents: number | null): string => (cents === null ? "" : (cents / 100).toFixed(2));
  return (
    <details className="mt-3 group/intel" open={!hasIntel}>
      <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[28px] select-none">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open/intel:rotate-90">
          <path d="M9 18l6-6-6-6" />
        </svg>
        {hasIntel ? "Edit intel" : "Add intel — website, base, bid range, strengths, weaknesses, notes"}
      </summary>
      {hasIntel && (
        <div className="mt-2 text-[11.5px] text-ppp-charcoal-600 space-y-0.5 pl-4">
          {competitor.website && (
            <div>🌐 <a href={competitor.website.startsWith("http") ? competitor.website : `https://${competitor.website}`} target="_blank" rel="noopener noreferrer" className="text-cc-brand-700 hover:underline">{competitor.website}</a></div>
          )}
          {competitor.home_base && <div>📍 {competitor.home_base}</div>}
          {(competitor.typical_bid_low_cents !== null || competitor.typical_bid_high_cents !== null) && (
            <div>
              💰 Typical bids:{" "}
              {competitor.typical_bid_low_cents !== null && formatCentsCompact(competitor.typical_bid_low_cents)}
              {competitor.typical_bid_low_cents !== null && competitor.typical_bid_high_cents !== null && " – "}
              {competitor.typical_bid_high_cents !== null && formatCentsCompact(competitor.typical_bid_high_cents)}
            </div>
          )}
          {competitor.strengths && <div className="text-emerald-800"><strong>Strengths:</strong> {competitor.strengths}</div>}
          {competitor.weaknesses && <div className="text-rose-800"><strong>Weaknesses:</strong> {competitor.weaknesses}</div>}
          {competitor.notes && <div className="text-ppp-charcoal-700 whitespace-pre-wrap"><strong>Notes:</strong> {competitor.notes}</div>}
        </div>
      )}
      <form action={updateIntelAction} className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 border-t border-ppp-charcoal-100 pt-3">
        <input type="hidden" name="id" value={competitor.id} />
        <label className="block sm:col-span-2">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Website</span>
          <input type="text" name="website" defaultValue={competitor.website ?? ""} maxLength={500} placeholder="abcpainting.com" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[40px]" />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Home base</span>
          <input type="text" name="home_base" defaultValue={competitor.home_base ?? ""} maxLength={200} placeholder="Bronx, NY" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[40px]" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Bid low ($)</span>
            <input type="text" name="bid_low" defaultValue={dollarStr(competitor.typical_bid_low_cents)} inputMode="decimal" placeholder="10000" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[40px] tabular-nums" />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Bid high ($)</span>
            <input type="text" name="bid_high" defaultValue={dollarStr(competitor.typical_bid_high_cents)} inputMode="decimal" placeholder="75000" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[40px] tabular-nums" />
          </label>
        </div>
        <label className="block">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Strengths</span>
          <textarea name="strengths" defaultValue={competitor.strengths ?? ""} maxLength={2000} rows={2} placeholder="Fast turnaround; strong GC relationships in the Bronx." className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 resize-y" />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Weaknesses</span>
          <textarea name="weaknesses" defaultValue={competitor.weaknesses ?? ""} maxLength={2000} rows={2} placeholder="Weak on high-rise; won't do restoration work." className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 resize-y" />
        </label>
        <label className="block sm:col-span-2">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">General notes</span>
          <textarea name="notes" defaultValue={competitor.notes ?? ""} maxLength={4000} rows={3} placeholder="Anything else the team should know — pricing tendencies, key contacts, past incidents…" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 resize-y" />
        </label>
        <div className="sm:col-span-2 flex justify-end">
          <button type="submit" className="inline-flex items-center px-4 py-2 rounded-md bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[40px]">
            Save intel
          </button>
        </div>
      </form>
    </details>
  );
}

/** Karan 2026-07-09: reused tile shape for the intelligence strip at
 *  the top of the Competitors page. Tone-driven so "top rival" reads
 *  red and "win rate ≥50%" reads emerald without a legend. */
function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "good" | "bad";
}) {
  const valueCls =
    tone === "good"
      ? "text-emerald-700"
      : tone === "bad"
      ? "text-rose-700"
      : "text-ppp-charcoal";
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 shadow-sm">
      <div className="text-[12px] font-semibold text-ppp-charcoal-700">{label}</div>
      <div className={`text-xl sm:text-2xl font-bold tabular-nums mt-1 truncate ${valueCls}`} title={value}>
        {value}
      </div>
      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 truncate" title={sub}>{sub}</div>
    </div>
  );
}
