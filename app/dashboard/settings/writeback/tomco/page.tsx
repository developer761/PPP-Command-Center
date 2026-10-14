import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminProfile } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import PageHeader from "@/components/page-header";
import {
  listUnpairedSoldDeals,
  listOpenSalesforceCandidates,
  listResolvedDeals,
  pairDealToSalesforce,
  markDealAsNew,
  recordPairingDecision,
  undoDecision,
  rankCandidates,
  type RankedCandidate,
  type SoldDeal,
} from "@/lib/salesforce/tomco-pairing";
import { decideWriteBack, SF_ENTRY_STOPPED } from "@/lib/salesforce/tomco-decide";

/**
 * Tomco write-back — the review queue.
 *
 * The write-back runs unattended. This page exists for the one thing it will
 * not do on its own: decide whether a sold deal is ALREADY in Salesforce.
 *
 * That question had no safe automatic answer for the backlog. Of the four sold
 * deals unlinked on 2026-10-14, two had a Salesforce twin — Cummins matching to
 * the cent, PCCI Eastport matching the job but not the price, because it was
 * renegotiated after the estimate went out. Writing either in unattended would
 * have put a second copy of a real sale into the total Katie runs the company
 * on, and nothing downstream would have flagged it: both records look right.
 *
 * It is a SHRINKING queue, not a permanent chore. Katie stopped Salesforce
 * entry on 2026-10-14, so only deals that predate that can have a twin. Each
 * one either sells and gets cleared here, or its estimate dies. Nothing refills
 * it — which is why this is a queue and not a workflow.
 *
 * Lives under /dashboard rather than /commercial because the Commercial
 * platform is deliberately walled off from `lib/salesforce/*`, and this is a
 * Salesforce surface.
 */

export const metadata = { title: "Tomco write-back" };
export const dynamic = "force-dynamic";

const BASE = "/dashboard/settings/writeback/tomco";

async function requireAdmin(): Promise<{ id: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const admin = isAdminProfile(profile) || isAdminEmail(user.email);
  if (!admin) redirect("/dashboard");
  return { id: user.id };
}

async function pairAction(formData: FormData) {
  "use server";
  const { id: userId } = await requireAdmin();
  const dealId = String(formData.get("dealId") ?? "");
  const sfId = String(formData.get("sfId") ?? "");
  const seen = JSON.parse(String(formData.get("seen") ?? "[]")) as Array<{ sfId: string; name: string; score: number }>;
  if (!dealId || !sfId) redirect(`${BASE}?error=${encodeURIComponent("Missing the deal or the Salesforce record.")}`);

  const res = await pairDealToSalesforce({ dealId, sfOpportunityId: sfId, actorUserId: userId });
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  await recordPairingDecision({ dealId, sfOpportunityId: sfId, actorUserId: userId, candidatesSeen: seen });
  revalidatePath(BASE);
  redirect(`${BASE}?ok=${encodeURIComponent("Linked. The write-back will update that Salesforce record from now on.")}`);
}

async function markNewAction(formData: FormData) {
  "use server";
  const { id: userId } = await requireAdmin();
  const dealId = String(formData.get("dealId") ?? "");
  const seen = JSON.parse(String(formData.get("seen") ?? "[]")) as Array<{ sfId: string; name: string; score: number }>;
  if (!dealId) redirect(`${BASE}?error=${encodeURIComponent("Missing the deal.")}`);
  const res = await markDealAsNew({ dealId, actorUserId: userId, candidatesSeen: seen });
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  revalidatePath(BASE);
  redirect(`${BASE}?ok=${encodeURIComponent("Marked as a new sale. The write-back will add it to Salesforce on its next run.")}`);
}

async function undoAction(formData: FormData) {
  "use server";
  const { id: userId } = await requireAdmin();
  const dealId = String(formData.get("dealId") ?? "");
  const res = await undoDecision({ dealId, actorUserId: userId });
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  revalidatePath(BASE);
  redirect(`${BASE}?ok=${encodeURIComponent("Put back in the queue.")}`);
}

const money = (cents: number | null) =>
  cents == null ? "—" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default async function TomcoWritebackPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  let deals: SoldDeal[] = [];
  let candidates: Awaited<ReturnType<typeof listOpenSalesforceCandidates>> = [];
  let resolved = new Map<string, Awaited<ReturnType<typeof listResolvedDeals>> extends Map<string, infer V> ? V : never>();
  let loadError: string | null = null;
  const created = new Map<string, string | null>();

  try {
    [deals, candidates, resolved] = await Promise.all([
      listUnpairedSoldDeals(),
      listOpenSalesforceCandidates(),
      listResolvedDeals(),
    ]);
    // Creation dates decide whether a deal CAN have a twin.
    const supabase = await createClient();
    const { data } = await supabase
      .from("commercial_opportunities")
      .select("id, created_at")
      .in("id", deals.map((d) => d.id));
    for (const r of data ?? []) created.set(r.id as string, (r.created_at as string) ?? null);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const held: Array<{ deal: SoldDeal; why: string; candidates: RankedCandidate[] }> = [];
  const automatic: Array<{ deal: SoldDeal; why: string }> = [];
  for (const deal of deals) {
    if (resolved.has(deal.id)) continue;
    const plan = decideWriteBack({
      deal,
      pairedSfId: null, // unpaired by definition — listUnpairedSoldDeals filtered them
      openCandidates: candidates,
      dealCreatedAt: created.get(deal.id) ?? null,
    });
    if (plan.action === "hold") held.push({ deal, why: plan.why, candidates: plan.candidates });
    else automatic.push({ deal, why: plan.why });
  }

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Tomco write-back"
        subtitle="Sold jobs going into Salesforce. Runs on its own, except where a deal might already be there."
      />

      <Link
        href="/dashboard/settings/writeback"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-ppp-orange"
      >
        ← Writeback settings
      </Link>

      {sp.error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{sp.error}</div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{sp.ok}</div>
      )}

      {loadError ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-bold text-amber-900">Couldn&apos;t load the queue</h2>
          <p className="mt-1 text-[13px] text-amber-800">{loadError}</p>
          <p className="mt-2 text-[12px] text-amber-700">
            Nothing has been written to Salesforce. Showing an empty queue here would read as
            &ldquo;all clear&rdquo;, which is the one thing it must not say when it cannot tell.
          </p>
        </div>
      ) : (
        <>
          {/* ── what needs a person ── */}
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400">
                Needs a decision
              </h2>
              <p className="mt-1 text-[13px] text-ppp-charcoal-500">
                These were sold before {SF_ENTRY_STOPPED}, when estimates were still being entered in
                Salesforce by hand — so each one might already be there. Adding a second copy would
                double-count a real sale, so the write-back stops and asks.
              </p>
            </div>

            {held.length === 0 ? (
              <div className="rounded-xl border border-ppp-charcoal-100 bg-surface p-5">
                <p className="text-sm text-ppp-charcoal-600">
                  Nothing waiting. Every sold deal is either already linked to Salesforce or clear to
                  go in on its own.
                </p>
              </div>
            ) : (
              held.map(({ deal, why, candidates: cands }) => {
                const seen = JSON.stringify(cands.map((c) => ({ sfId: c.sfId, name: c.name, score: c.score })));
                return (
                  <div key={deal.id} className="rounded-xl border border-ppp-charcoal-100 bg-surface p-5 space-y-4">
                    <div>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="text-base font-bold text-ppp-charcoal">{deal.title}</h3>
                        <span className="font-mono text-sm tabular-nums text-ppp-charcoal-600">
                          {money(deal.contractCents)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[12.5px] text-ppp-charcoal-500">
                        {deal.accountName ?? "No account"}
                        {deal.decidedAt ? ` · sold ${deal.decidedAt.slice(0, 10)}` : ""}
                      </p>
                      <p className="mt-2 text-[13px] text-ppp-charcoal-600">{why}</p>
                    </div>

                    <div className="space-y-2">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                        Is it one of these?
                      </p>
                      {cands.map((c) => (
                        <div
                          key={c.sfId}
                          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50 px-3.5 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <span className="text-[13.5px] font-semibold text-ppp-charcoal">{c.name}</span>
                              <span className="font-mono text-[12.5px] tabular-nums text-ppp-charcoal-600">
                                {money(c.subtotalCents)}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[12px] text-ppp-charcoal-500">
                              {c.accountName ?? "No account"} · {c.stageName}
                              {c.closeDate ? ` · ${c.closeDate}` : ""}
                            </p>
                            {/* The reasons are the point: a reader checks the
                                machine's working rather than trusting a score. */}
                            <p className="mt-1 text-[12px] text-ppp-charcoal-600">{c.reasons.join(" · ")}</p>
                          </div>
                          <form action={pairAction} className="shrink-0">
                            <input type="hidden" name="dealId" value={deal.id} />
                            <input type="hidden" name="sfId" value={c.sfId} />
                            <input type="hidden" name="seen" value={seen} />
                            <button
                              type="submit"
                              disabled={c.alreadyPaired}
                              className="min-h-[44px] rounded-lg bg-cc-brand-700 px-3.5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-cc-brand-800 disabled:opacity-40"
                            >
                              {c.alreadyPaired ? "Taken" : "Same job"}
                            </button>
                          </form>
                        </div>
                      ))}
                    </div>

                    <form action={markNewAction} className="border-t border-ppp-charcoal-100 pt-3">
                      <input type="hidden" name="dealId" value={deal.id} />
                      <input type="hidden" name="seen" value={seen} />
                      <button
                        type="submit"
                        className="min-h-[44px] rounded-lg border border-ppp-charcoal-200 px-3.5 py-2 text-xs font-bold uppercase tracking-wide text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                      >
                        None of these — it&apos;s a new sale
                      </button>
                    </form>
                  </div>
                );
              })
            )}
          </section>

          {/* ── what goes without asking ── */}
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400">
                Going in on their own
              </h2>
              <p className="mt-1 text-[13px] text-ppp-charcoal-500">
                Nothing in Salesforce could be these, so the write-back adds them without asking.
                Listed so the automatic half is visible rather than silent.
              </p>
            </div>
            {automatic.length === 0 ? (
              <p className="text-[13px] text-ppp-charcoal-500">None right now.</p>
            ) : (
              <div className="divide-y divide-ppp-charcoal-100 overflow-hidden rounded-xl border border-ppp-charcoal-100 bg-surface">
                {automatic.map(({ deal, why }) => (
                  <div key={deal.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-0">
                      <span className="text-[13.5px] font-semibold text-ppp-charcoal">{deal.title}</span>
                      <p className="text-[12px] text-ppp-charcoal-500">{why}</p>
                    </div>
                    <span className="font-mono text-[13px] tabular-nums text-ppp-charcoal-600">
                      {money(deal.contractCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── already decided ── */}
          {resolved.size > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400">
                Already decided
              </h2>
              <div className="divide-y divide-ppp-charcoal-100 overflow-hidden rounded-xl border border-ppp-charcoal-100 bg-surface">
                {[...resolved.values()].map((d) => (
                  <div key={d.opportunityId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 text-[13px]">
                      <span className="font-semibold text-ppp-charcoal">
                        {d.decision === "new" ? "Marked a new sale" : "Linked to Salesforce"}
                      </span>
                      <span className="ml-2 font-mono text-[12px] text-ppp-charcoal-500">
                        {d.sfOpportunityId ?? d.opportunityId.slice(0, 8)}
                      </span>
                      <span className="ml-2 text-[12px] text-ppp-charcoal-500">
                        {d.decidedAt.slice(0, 10)}
                      </span>
                    </div>
                    <form action={undoAction}>
                      <input type="hidden" name="dealId" value={d.opportunityId} />
                      <button
                        type="submit"
                        className="min-h-[44px] rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                      >
                        Undo
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
