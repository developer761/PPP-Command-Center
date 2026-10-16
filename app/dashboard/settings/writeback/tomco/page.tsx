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
import { listQueueForReview, type QueueReviewRow } from "@/lib/salesforce/tomco-queue";

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
/** Queue entry ids come from a form post, so they are checked before use. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Put a stalled entry back in the queue.
 *
 * An entry that spends its three attempts is never claimed again, and the
 * nightly sweep cannot rescue it either — so without this it is stuck for good
 * AND it blocks every future entry for that deal, with no remedy but editing
 * the table by hand. A red row with no button is this codebase's own definition
 * of documenting a trap rather than fixing it.
 */
async function rearmAction(formData: FormData) {
  "use server";
  await requireAdmin();
  const id = String(formData.get("entry_id") ?? "");
  if (!UUID_RE.test(id)) redirect(`${BASE}?error=${encodeURIComponent("Unknown queue entry.")}`);
  const { rearmStalled } = await import("@/lib/salesforce/tomco-queue");
  const res = await rearmStalled(id);
  revalidatePath(BASE);
  redirect(
    res.ok
      ? `${BASE}?ok=${encodeURIComponent("Back in the queue — the next tick will try it again.")}`
      : `${BASE}?error=${encodeURIComponent(res.error ?? "Could not re-queue it.")}`,
  );
}

/**
 * "It is a genuine second change order at this amount — create it."
 *
 * The only escape from the hold `syncChangeOrder` applies when every Salesforce
 * change order at that amount already belongs to a different Command Center
 * one. Without it that hold is permanent: holding does not count as an attempt,
 * so the entry never becomes "stopped asking", so the retry button never shows,
 * and the sweep skips anything still pending. The work would simply never reach
 * Salesforce.
 */
async function allowSecondCoAction(formData: FormData) {
  "use server";
  const { id: userId } = await requireAdmin();
  const coId = String(formData.get("change_order_id") ?? "");
  if (!UUID_RE.test(coId)) redirect(`${BASE}?error=${encodeURIComponent("Unknown change order.")}`);
  const { allowSecondChangeOrder } = await import("@/lib/salesforce/tomco-changeorder");
  const res = await allowSecondChangeOrder(coId, userId);
  revalidatePath(BASE);
  redirect(
    res.ok
      ? `${BASE}?ok=${encodeURIComponent("Noted — the next tick will add it to Salesforce as a second change order.")}`
      : `${BASE}?error=${encodeURIComponent(res.error ?? "Could not record that.")}`,
  );
}

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

  /*
   * THE LIVE QUEUE, read separately and never allowed to break the page.
   *
   * The pairing half of this screen is the one that needs Salesforce; the queue
   * is a local table. Read in its own try so an unreachable org still shows
   * what is waiting — and so the reverse is true too, which matters because
   * this is the only place the automatic half of the feature is visible at all.
   */
  let queue: QueueReviewRow[] = [];
  let queueError: string | null = null;
  let queueTableMissing = false;
  try {
    const q = await listQueueForReview();
    queue = q.rows;
    queueTableMissing = q.tableMissing;
  } catch (err) {
    queueError = err instanceof Error ? err.message : String(err);
  }
  const waiting = queue.filter((q) => !q.doneAt && !q.stalled && !q.heldReason);
  const heldInQueue = queue.filter((q) => !q.doneAt && q.heldReason);
  const stalled = queue.filter((q) => q.stalled);
  /*
   * Written, and the read-back disagreed. Deliberately NOT filtered to pending
   * entries — a finished one with this set is the dangerous case, because
   * everything else about it reads as a success.
   */
  const unverified = queue.filter((q) => q.verifyFailedAt && !q.stalled);
  // The newest finish, not the first row that has one: the list leads with
  // pending and unverified entries, which can be any age.
  const lastDone = queue.reduce<string | null>((m, q) => (q.doneAt && (!m || q.doneAt > m) ? q.doneAt : m), null);

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

  const held: Array<{ deal: SoldDeal; why: string; candidates: RankedCandidate[]; othersChecked: number }> = [];
  const automatic: Array<{ deal: SoldDeal; why: string }> = [];
  for (const deal of deals) {
    if (resolved.has(deal.id)) continue;
    const plan = decideWriteBack({
      deal,
      pairedSfId: null, // unpaired by definition — listUnpairedSoldDeals filtered them
      openCandidates: candidates,
      dealCreatedAt: created.get(deal.id) ?? null,
    });
    if (plan.action === "hold") held.push({ deal, why: plan.why, candidates: plan.candidates, othersChecked: plan.othersChecked });
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

      {/* ── the automatic half, made visible ── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400">Live sync</h2>
          <p className="mt-1 text-[13px] text-ppp-charcoal-500">
            A sold job, or a change order approved on one, is queued the moment it happens and written
            to Salesforce within the minute. Shown here because a sync that works is otherwise
            invisible — and &ldquo;it syncs automatically&rdquo; is not a claim anyone should have to
            take on trust.
          </p>
        </div>
        {queueError ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            Couldn&apos;t read the queue: {queueError}
          </div>
        ) : queueTableMissing ? (
          /*
           * NOT an empty queue — a queue that does not exist yet. Saying
           * "nothing waiting" here would read as all-clear while every sale
           * since the deploy sat unsynced.
           */
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            <span className="font-semibold">The live sync is not switched on yet.</span> Its table or
            one of its columns is missing, so nothing is being queued and nothing is being written.
            Apply any unrun migration named{" "}
            <code className="font-mono text-[12px]">*_tomco_writeback_queue*.sql</code> — there are two,
            and the second adds columns the first does not. The next nightly sweep then queues
            everything already sold.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-ppp-charcoal-100 bg-surface">
            <div className="grid grid-cols-2 divide-x divide-y divide-ppp-charcoal-100 border-b border-ppp-charcoal-100 sm:grid-cols-4 sm:divide-y-0">
              {[
                { n: waiting.length, label: "waiting", hint: "goes within the minute" },
                { n: heldInQueue.length, label: "needs a person", hint: "waiting on a decision" },
                { n: stalled.length, label: "stopped asking", hint: "out of retries" },
                { n: unverified.length, label: "not verified", hint: "written, read-back disagreed" },
              ].map((c) => (
                <div key={c.label} className="px-4 py-3">
                  <div
                    className={`font-mono text-xl font-bold tabular-nums ${
                      (c.label === "stopped asking" || c.label === "not verified") && c.n > 0
                        ? "text-rose-700"
                        : "text-ppp-charcoal"
                    }`}
                  >
                    {c.n}
                  </div>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">{c.label}</div>
                  <div className="text-[11px] text-ppp-charcoal-400">{c.hint}</div>
                </div>
              ))}
            </div>
            {/*
              The failures first: they are the only rows that need acting on.
              EVERY one of them — this list used to stop at 14 rows of a
              40-row read, so an unverified write could sit off the screen
              with a tile reading zero. Only the "waiting" rows, which need
              nobody, are capped.
            */}
            {[...stalled, ...unverified.filter((q) => !q.heldReason), ...heldInQueue, ...waiting.slice(0, 25)].map((q) => (
              <div key={q.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-ppp-charcoal-100 px-4 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <span className="text-[13.5px] font-semibold text-ppp-charcoal">{q.label}</span>
                  {q.kind === "change_order" && (
                    <span className="ml-2 rounded bg-ppp-charcoal-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-600">
                      change order
                    </span>
                  )}
                  <p className={`text-[12px] ${q.stalled ? "text-rose-700" : "text-ppp-charcoal-500"}`}>
                    {q.stalled
                      ? `Stopped after ${q.attempts} attempts — ${q.lastError ?? "no reason recorded"}`
                      : q.heldReason ?? "queued"}
                  </p>
                  {/*
                    A write whose read-back disagreed. Shown even when the entry
                    is finished, because that is exactly the case that used to
                    disappear: the retry found Salesforce already in its new
                    state, said "nothing to do", and the row went green.
                  */}
                  {q.verifyFailedAt && (
                    <p className="mt-1 text-[12px] text-amber-800">
                      <span className="font-semibold">Written but not verified.</span>{" "}
                      {q.verifyFailedReason ?? "a read-back disagreed"}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[11px] tabular-nums text-ppp-charcoal-400">
                    {q.queuedAt.slice(0, 16).replace("T", " ")}
                  </span>
                  {!q.doneAt && q.kind === "change_order" && q.changeOrderId && /second change order|already linked to a different|additional to them/i.test(q.heldReason ?? "") && (
                    <form action={allowSecondCoAction}>
                      <input type="hidden" name="change_order_id" value={q.changeOrderId} />
                      <button
                        type="submit"
                        className="min-h-[44px] rounded-lg border border-ppp-charcoal-300 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                      >
                        It&apos;s a second one — add it
                      </button>
                    </form>
                  )}
                  {q.stalled && (
                    <form action={rearmAction}>
                      <input type="hidden" name="entry_id" value={q.id} />
                      <button
                        type="submit"
                        className="min-h-[44px] rounded-lg border border-rose-300 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-rose-700 hover:bg-rose-50"
                      >
                        Try again
                      </button>
                    </form>
                  )}
                  {/*
                    A hold that waits for a person is parked — nothing re-checks
                    it on a timer any more — so the person needs the way to say
                    "done, look again". If the reason still stands, the next
                    tick parks it again with the same words.
                  */}
                  {q.waitingForPerson && (
                    <form action={rearmAction}>
                      <input type="hidden" name="entry_id" value={q.id} />
                      <button
                        type="submit"
                        className="min-h-[44px] rounded-lg border border-ppp-charcoal-300 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                      >
                        Re-check
                      </button>
                    </form>
                  )}
                </div>
              </div>
            ))}
            {waiting.length > 25 && (
              <p className="border-b border-ppp-charcoal-100 px-4 py-2 text-[12px] text-ppp-charcoal-500">
                and {waiting.length - 25} more waiting — they go within the minute and need nobody.
              </p>
            )}
            {queue.length === 0 && (
              <p className="px-4 py-3 text-[13px] text-ppp-charcoal-500">
                Nothing in the queue. Everything sold here is already in Salesforce.
              </p>
            )}
            {lastDone && (
              <p className="border-t border-ppp-charcoal-100 px-4 py-2 text-[11px] text-ppp-charcoal-400">
                Last written {lastDone.slice(0, 16).replace("T", " ")}
              </p>
            )}
          </div>
        )}
      </section>

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
              held.map(({ deal, why, candidates: cands, othersChecked }) => {
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

                    {othersChecked > 0 && (
                      <p className="text-[12px] text-ppp-charcoal-500">
                        {othersChecked} other open estimate{othersChecked === 1 ? " was" : "s were"} checked and
                        resemble{othersChecked === 1 ? "s" : ""} nothing about this job.
                      </p>
                    )}

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
