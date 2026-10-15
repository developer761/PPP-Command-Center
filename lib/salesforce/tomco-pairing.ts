import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { getSalesforceClient } from "@/lib/salesforce/client";
import { writeSf } from "@/lib/salesforce/writeback";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { assertSalesforceId } from "@/lib/salesforce/soql";

/**
 * Stage 1 of the Tomco write-back: linking a sale that exists in BOTH systems.
 *
 * WHY A HUMAN DOES THIS ONCE
 *
 * Tomco's estimates were entered in Salesforce by hand AND in the Command
 * Center by the estimator, so the same job existed twice before it was ever
 * sold. Measured 2026-10-14: of the four sold deals not yet linked, two already
 * had a Salesforce twin — Cummins matching to the cent, PCCI Eastport matching
 * the job but not the price, because it was renegotiated after the estimate
 * went out. Writing those in unconditionally would have double-counted exactly
 * the total Katie wants to see.
 *
 * No matcher can decide it. Exact name match misses both; substring misses
 * PCCI; amount catches Cummins and misses PCCI, whose whole point is that the
 * price moved. And Salesforce holds two byte-identical `Tesla-Islip`
 * opportunities created the same day for the same amount, so even a perfect
 * matcher has no single right answer. So this module RANKS candidates and a
 * person picks; it never decides.
 *
 * Katie has since told Mary to stop creating anything in Salesforce, which
 * makes this a one-off against a closed set — the 43 open estimates — rather
 * than a permanent step. It is not needed for any deal created after
 * 2026-10-14.
 *
 * See docs/TOMCO_SF_WRITEBACK_PLAN.md §4 and §4a.
 */

/** Deals in these statuses are sold. `lib/commercial/opportunities/status.ts`. */
const SOLD_STATUSES = [
  "pre_sale_closed",
  "pre_construction",
  "in_progress",
  "billing",
  "post_sale_closed",
] as const;

const TOMCO = "Corporate_Name__c = 'Tomco Painting'";

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export type SoldDeal = {
  id: string;
  title: string;
  accountName: string | null;
  contractCents: number | null;
  decidedAt: string | null;
};

export type SfCandidate = {
  sfId: string;
  name: string;
  accountName: string | null;
  stageName: string;
  closeDate: string | null;
  subtotalCents: number | null;
  /** Already carries somebody's external id — pairing to it would overwrite. */
  alreadyPaired: boolean;
};

export type RankedCandidate = SfCandidate & {
  /** 0–100. Not a probability — an ordering, so the likely match is on top. */
  score: number;
  /** Why it scored, in words a person reading the screen can check. */
  reasons: string[];
};

/**
 * Order the open Salesforce estimates by how likely each is to be this deal.
 *
 * PURE, and separated from the queries so it can be tested on the real pairs
 * rather than on fixtures invented to match it. The weights say what they are:
 * the account is the strongest signal (a GC's job is on that GC's account), the
 * amount is strong but breaks on renegotiation, and the date only breaks ties.
 *
 * Deliberately NOT a threshold. Nothing here auto-pairs, so a wrong order costs
 * a reader one extra glance, while a wrong auto-decision costs a double-counted
 * sale.
 */
export function rankCandidates(deal: SoldDeal, candidates: SfCandidate[]): RankedCandidate[] {
  const dealWords = tokenize(deal.title);
  return candidates
    .map((c) => {
      const reasons: string[] = [];
      let score = 0;

      if (deal.accountName && c.accountName && sameCompany(deal.accountName, c.accountName)) {
        score += 50;
        reasons.push("same account");
      }

      if (deal.contractCents != null && c.subtotalCents != null && c.subtotalCents > 0) {
        const diff = Math.abs(deal.contractCents - c.subtotalCents);
        if (diff === 0) {
          score += 35;
          reasons.push("amount matches to the cent");
        } else if (diff / Math.max(deal.contractCents, c.subtotalCents) <= 0.2) {
          score += 18;
          reasons.push(`amount within ${Math.round((diff / Math.max(deal.contractCents, c.subtotalCents)) * 100)}%`);
        }
      }

      // Word overlap catches "Facade Renovation-Eastport" against
      // "PCCI Builders Corp. Eastport Facade Renovation", where neither exact
      // nor substring matching does.
      const shared = tokenize(c.name).filter((w) => dealWords.includes(w));
      if (shared.length > 0) {
        score += Math.min(20, shared.length * 7);
        reasons.push(`words in common: ${shared.slice(0, 3).join(", ")}`);
      }

      if (deal.decidedAt && c.closeDate) {
        const days = Math.abs(
          (new Date(deal.decidedAt).getTime() - new Date(c.closeDate).getTime()) / 86_400_000,
        );
        if (Number.isFinite(days) && days <= 90) {
          score += 10;
          reasons.push(`closed within ${Math.round(days)} days`);
        }
      }

      // A record already carrying an external id belongs to another deal.
      // Shown, never hidden — but sorted last and flagged, because pairing onto
      // it would silently steal the link.
      if (c.alreadyPaired) {
        score -= 1000;
        reasons.push("⚠ already linked to another deal");
      }

      return { ...c, score: Math.max(0, Math.min(100, score)), reasons };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Words worth comparing: lower-cased, punctuation gone, noise dropped. */
const NOISE = new Set([
  "the", "and", "of", "inc", "llc", "corp", "co", "ltd", "company", "construction",
  "builders", "building", "group", "contracting", "contractors", "services", "management",
]);
function tokenize(s: string | null): string[] {
  return [
    ...new Set(
      String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !NOISE.has(w)),
    ),
  ];
}
/** Company names match on their meaningful words, not character-for-character. */
function sameCompany(a: string, b: string): boolean {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const overlap = ta.filter((w) => tb.includes(w)).length;
  return overlap / Math.min(ta.length, tb.length) >= 0.5;
}

/** Sold Command Center deals with no Salesforce link yet. */
export async function listUnpairedSoldDeals(): Promise<SoldDeal[]> {
  const sb = adminClient();
  /*
   * The deal's NAME comes from `derivedOppName`, the same function every other
   * surface uses — not a local `title_override || title`.
   *
   * `check:columns` caught the first version doing exactly that: reading
   * `title_override` without `title_override_mode` means the nickname REPLACES
   * the GC and the address instead of appending, which is the defect that hit
   * ~50 surfaces before migration 170. A pairing screen showing a different
   * name from the rest of the app would be worse here than elsewhere, because
   * the name is what a person matches on.
   */
  const { data: deals, error } = await sb
    .from("commercial_opportunities")
    .select(DEAL_COLS)
    .in("status", SOLD_STATUSES as unknown as string[])
    .is("deleted_at", null);
  if (error) throw new Error(`sold deals: ${error.message}`);

  // One definition of sold, shared with `loadSoldDeal` — the sub-status half of
  // the rule is easy to write once and forget the second time.
  const sold = (deals ?? []).filter((d) => isSoldStatus(d.status, d.sub_status));
  if (sold.length === 0) return [];

  // Paging is deliberate: commercial_import_map's primary key is
  // (sf_id, entity) and it has no `id` column, so it cannot be ordered by one.
  const mapped = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error: mErr } = await sb
      .from("commercial_import_map")
      .select("row_id")
      .eq("entity", "deal")
      .order("sf_id")
      .range(from, from + 999);
    if (mErr) throw new Error(`import map: ${mErr.message}`);
    for (const r of data ?? []) mapped.add(r.row_id as string);
    if (!data || data.length < 1000) break;
  }

  const acctIds = [...new Set(sold.map((d) => d.account_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (acctIds.length > 0) {
    const { data: accts } = await sb
      .from("commercial_accounts")
      .select("id, company_name")
      .in("id", acctIds);
    for (const a of accts ?? []) names.set(a.id as string, a.company_name as string);
  }

  return sold
    .filter((d) => !mapped.has(d.id as string))
    .map((d) => ({
      id: d.id as string,
      title: derivedOppName(
        d as unknown as Parameters<typeof derivedOppName>[0],
        d.account_id ? names.get(d.account_id as string) ?? null : null,
      ),
      accountName: d.account_id ? names.get(d.account_id as string) ?? null : null,
      contractCents: d.accepted_contract_cents as number | null,
      decidedAt: d.decided_at as string | null,
    }));
}

/** The columns a `SoldDeal` is built from. One list, so the two readers agree. */
const DEAL_COLS =
  "id, title, title_override, title_override_mode, client_name, property_street, status, sub_status, accepted_contract_cents, decided_at, created_at, account_id, deleted_at";

/** Is this status/sub-status pair a SOLD deal? The one definition. */
export function isSoldStatus(status: string | null, subStatus: string | null): boolean {
  if (!status || !(SOLD_STATUSES as readonly string[]).includes(status)) return false;
  return !(status === "pre_sale_closed" && subStatus !== "won");
}

/**
 * One deal, as the write-back needs it — for the per-minute tick, which has a
 * single opportunity id and no reason to read all 98.
 *
 * Returns `sold: false` rather than null for a deal that is no longer sold:
 * that is a real answer the tick acts on (the queue entry is finished, nothing
 * is written), and it must not be confused with "deal not found".
 */
export async function loadSoldDeal(
  opportunityId: string,
): Promise<{ deal: SoldDeal; createdAt: string | null; sold: boolean } | null> {
  const sb = adminClient();
  const { data, error } = await sb
    .from("commercial_opportunities")
    .select(DEAL_COLS)
    .eq("id", opportunityId)
    .maybeSingle();
  if (error) throw new Error(`deal ${opportunityId}: ${error.message}`);
  if (!data) return null;
  const d = data as Record<string, unknown>;
  if (d.deleted_at) return null;

  let accountName: string | null = null;
  if (d.account_id) {
    const { data: acct } = await sb
      .from("commercial_accounts")
      .select("company_name")
      .eq("id", d.account_id as string)
      .maybeSingle();
    accountName = (acct as { company_name?: string } | null)?.company_name ?? null;
  }
  return {
    deal: {
      id: d.id as string,
      // `derivedOppName`, like every other surface — never `title_override ||
      // title`, which makes the nickname replace the GC and the address.
      title: derivedOppName(d as unknown as Parameters<typeof derivedOppName>[0], accountName),
      accountName,
      contractCents: (d.accepted_contract_cents as number | null) ?? null,
      decidedAt: (d.decided_at as string | null) ?? null,
    },
    createdAt: (d.created_at as string | null) ?? null,
    sold: isSoldStatus(d.status as string | null, d.sub_status as string | null),
  };
}

/** The open Tomco estimates a sold deal could be. */
export async function listOpenSalesforceCandidates(): Promise<SfCandidate[]> {
  const conn = await getSalesforceClient();
  const out: SfCandidate[] = [];
  let r = await conn.query(
    `SELECT Id, Name, StageName, CloseDate, Quote_Subtotal__c, UniqueExternalId__c, Account.Name
       FROM Opportunity
      WHERE ${TOMCO} AND IsClosed = false
      ORDER BY CloseDate DESC`,
  );
  const take = (recs: Array<Record<string, unknown>>) => {
    for (const o of recs) {
      const acct = o.Account as { Name?: string } | null;
      const sub = o.Quote_Subtotal__c as number | null;
      out.push({
        sfId: o.Id as string,
        name: o.Name as string,
        accountName: acct?.Name ?? null,
        stageName: o.StageName as string,
        closeDate: (o.CloseDate as string) ?? null,
        subtotalCents: sub == null ? null : Math.round(Number(sub) * 100),
        alreadyPaired: !!o.UniqueExternalId__c,
      });
    }
  };
  take(r.records as Array<Record<string, unknown>>);
  while (!r.done) {
    r = await conn.queryMore(r.nextRecordsUrl!);
    take(r.records as Array<Record<string, unknown>>);
  }
  return out;
}

export type PairResult =
  | { ok: true; sfId: string }
  | { ok: false; error: string };

/**
 * Link a Command Center deal to the Salesforce opportunity that is the same job.
 *
 * Two writes, in this order, because the second is the one that is safe to
 * repeat: Salesforce first, then our map row. If the Salesforce write fails
 * nothing local changes and the screen still shows the deal as unpaired. If the
 * map row fails, the external id is set and re-running pairs it cleanly.
 */
export async function pairDealToSalesforce(input: {
  dealId: string;
  sfOpportunityId: string;
  actorUserId: string | null;
  /** Write through a sandbox connection instead of production. */
  connection?: Awaited<ReturnType<typeof getSalesforceClient>>;
}): Promise<PairResult> {
  const conn = input.connection ?? (await getSalesforceClient());

  /*
   * REFUSE TO STEAL A LINK. A record already carrying a different external id
   * belongs to another deal, and overwriting it would silently detach that one
   * — which nothing downstream would report, because both deals would then look
   * paired. Checked immediately before the write rather than trusting the list
   * the screen was rendered from, which may be minutes old.
   */
  const check = await conn.query(
    `SELECT Id, UniqueExternalId__c FROM Opportunity WHERE Id = '${assertSalesforceId(input.sfOpportunityId, "Salesforce opportunity id")}'`,
  );
  const existing = (check.records?.[0] as { UniqueExternalId__c?: string } | undefined)
    ?.UniqueExternalId__c;
  if (existing && existing !== input.dealId) {
    return {
      ok: false,
      error: `That Salesforce opportunity is already linked to a different deal (${existing}). Refresh and check before pairing.`,
    };
  }

  const res = await writeSf(
    {
      sObject: "Opportunity",
      recordId: input.sfOpportunityId,
      fields: { UniqueExternalId__c: input.dealId },
    },
    {
      source: "tomco_writeback",
      triggeredByUserId: input.actorUserId,
      priorValues: { UniqueExternalId__c: existing ?? null },
      // Pairing touches one field on one record and changes nothing a PPP
      // dashboard reads, so dropping the shared snapshot would cost an 8-15s
      // cold start for nothing.
      deferCacheInvalidation: true,
      ...(input.connection ? { connection: input.connection } : {}),
    },
  );
  if (!res.ok) return { ok: false, error: res.error };

  /*
   * THE MAP ROW, STAMPED AT THE EPOCH ON PURPOSE.
   *
   * `commercial_import_map.updated_at` is what the importer's `editedHere()`
   * compares a row's own `updated_at` against to decide who wins. A fresh
   * stamp here would make every field on this deal look untouched since the
   * last sync, and the next nightly run would overwrite the Command Center's
   * version with Salesforce's — the $500 contract value of §2⁰ included.
   *
   * Dated 1970 instead, so every Command Center row reads as human-edited and
   * the platform always wins for the whole dual run. docs §2e, point 1.
   */
  const sb = adminClient();
  const { error } = await sb.from("commercial_import_map").upsert(
    {
      sf_id: input.sfOpportunityId,
      entity: "deal",
      row_id: input.dealId,
      notes: `paired by the write-back pairing screen ${new Date().toISOString().slice(0, 10)}`,
      updated_at: new Date(0).toISOString(),
    },
    { onConflict: "sf_id,entity" },
  );
  if (error) {
    return {
      ok: false,
      error: `Salesforce was updated but the link did not save here (${error.message}). Pair it again — the Salesforce side is already correct, so it will finish cleanly.`,
    };
  }
  return { ok: true, sfId: input.sfOpportunityId };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Resolving a hold.
 *
 * Two answers, and only one of them has somewhere natural to live. "Same job"
 * writes `commercial_import_map`, which is already the link the importer reads.
 * "It's new" had nowhere, so a cleared deal came back in the queue every run —
 * and a queue that re-asks answered questions stops being read, which is how
 * the one genuinely risky item gets skimmed past.
 * ───────────────────────────────────────────────────────────────────────── */

const DECISIONS = "commercial_tomco_writeback_decisions";

export type HeldDecision = {
  opportunityId: string;
  decision: "new" | "paired";
  sfOpportunityId: string | null;
  decidedAt: string;
};

/** Deals a person has already cleared, so the queue stops asking. */
export async function listResolvedDeals(): Promise<Map<string, HeldDecision>> {
  const sb = adminClient();
  const { data, error } = await sb
    .from(DECISIONS)
    .select("opportunity_id, decision, sf_opportunity_id, decided_at, undone_at")
    .is("undone_at", null);
  if (error) {
    /*
     * A missing or unreadable decisions table must not make the queue claim
     * everything is unresolved — that would re-ask every answered question and
     * invite somebody to pair a deal twice. Fail loud instead of fail open.
     */
    throw new Error(
      `Could not read the write-back decisions (${error.message}). ` +
        `If this is a fresh environment, apply migration 20261014200000_tomco_writeback_decisions.sql.`,
    );
  }
  return new Map(
    (data ?? []).map((r) => [
      r.opportunity_id as string,
      {
        opportunityId: r.opportunity_id as string,
        decision: r.decision as "new" | "paired",
        sfOpportunityId: (r.sf_opportunity_id as string | null) ?? null,
        decidedAt: r.decided_at as string,
      },
    ]),
  );
}

/**
 * "None of these — it's a new sale." Records the judgement and what it was
 * made against, so the decision stays reviewable after the candidate list has
 * moved on. Writes nothing to Salesforce: the write-back inserts on its next
 * run, through the normal path.
 */
export async function markDealAsNew(input: {
  dealId: string;
  actorUserId: string | null;
  candidatesSeen: Array<{ sfId: string; name: string; score: number }>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = adminClient();
  const { error } = await sb.from(DECISIONS).upsert(
    {
      opportunity_id: input.dealId,
      decision: "new",
      sf_opportunity_id: null,
      candidates_seen: input.candidatesSeen,
      decided_by_user_id: input.actorUserId,
      decided_at: new Date().toISOString(),
      undone_at: null,
      undone_by_user_id: null,
    },
    { onConflict: "opportunity_id" },
  );
  if (error) return { ok: false, error: error.message };
  /*
   * Look at it NOW. A held queue entry otherwise waits out its back-off, so
   * somebody who has just answered the question watches nothing happen for up
   * to an hour — which is how a review queue stops being trusted.
   */
  const { releaseHold } = await import("@/lib/salesforce/tomco-queue");
  await releaseHold(input.dealId);
  return { ok: true };
}

/** Note a pairing for the audit trail. The LINK is the import-map row. */
export async function recordPairingDecision(input: {
  dealId: string;
  sfOpportunityId: string;
  actorUserId: string | null;
  candidatesSeen: Array<{ sfId: string; name: string; score: number }>;
}): Promise<void> {
  const sb = adminClient();
  // Best-effort: the pairing itself already succeeded in both systems, so a
  // failure to write the audit note must not report the pairing as failed.
  const { error } = await sb.from(DECISIONS).upsert(
    {
      opportunity_id: input.dealId,
      decision: "paired",
      sf_opportunity_id: input.sfOpportunityId,
      candidates_seen: input.candidatesSeen,
      decided_by_user_id: input.actorUserId,
      decided_at: new Date().toISOString(),
      undone_at: null,
      undone_by_user_id: null,
    },
    { onConflict: "opportunity_id" },
  );
  if (error) console.warn(`[tomco-pairing] audit note failed for ${input.dealId}: ${error.message}`);
  // Same as `markDealAsNew`: the hold has been answered, so the next tick
  // should act on it rather than the one an hour from now.
  const { releaseHold } = await import("@/lib/salesforce/tomco-queue");
  await releaseHold(input.dealId);
}

/**
 * Undo a decision.
 *
 * Somebody who clears a deal as new and then finds the twin needs to put it
 * back in the queue without a DBA. For a PAIRED deal this also has to remove
 * the import-map row, or the deal stays linked while the queue thinks it is
 * unresolved — the two would disagree, which is worse than either state.
 *
 * It does NOT clear `UniqueExternalId__c` in Salesforce. That is a deliberate
 * asymmetry: the field is harmless where it sits, re-pairing overwrites it, and
 * a mistaken undo should not reach into the other system.
 */
export async function undoDecision(input: {
  dealId: string;
  actorUserId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = adminClient();
  const { data: row } = await sb
    .from(DECISIONS)
    .select("decision, sf_opportunity_id")
    .eq("opportunity_id", input.dealId)
    .is("undone_at", null)
    .maybeSingle();

  if (row?.decision === "paired" && row.sf_opportunity_id) {
    const { error: mapErr } = await sb
      .from("commercial_import_map")
      .delete()
      .eq("sf_id", row.sf_opportunity_id as string)
      .eq("entity", "deal");
    if (mapErr) return { ok: false, error: `Could not unlink it: ${mapErr.message}` };
  }

  const { error } = await sb
    .from(DECISIONS)
    .update({ undone_at: new Date().toISOString(), undone_by_user_id: input.actorUserId })
    .eq("opportunity_id", input.dealId)
    .is("undone_at", null);
  return error ? { ok: false, error: error.message } : { ok: true };
}
