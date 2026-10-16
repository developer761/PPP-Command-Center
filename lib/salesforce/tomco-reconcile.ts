/**
 * Does one linked Tomco deal agree with its Salesforce opportunity — field by
 * field, on everything the write-back writes or the platform shows from there?
 *
 * PURE ON PURPOSE. `npm run check:salesforce` does the reading; this decides.
 * Kept apart so every rule has a test that drives it to "differ", because a
 * reconciliation whose comparisons cannot fail is the most dangerous kind of
 * green: it reported 96 of 98 for a week while 42 deals were not compared at
 * all and nothing but the contract was compared on the rest.
 *
 * WHICH FIELDS, AND WHY THESE
 *
 * The write-back (tomco-writeback.ts, tomco-changeorder.ts) writes:
 *   Opportunity  Name · StageName · CloseDate (create only) · RecordTypeId ·
 *                Pricebook2Id · LeadSource · UniqueExternalId__c · AccountId ·
 *                OwnerId (Brendan, create only) · SyncedQuoteId
 *   Quote        one per sale, Status = Approved
 *   QuoteLineItem one line, PriceOverrideAmount__c = the base contract
 *   ChangeOrder__c CostChange__c · Status__c
 * and refuses to touch anything whose Corporate_Name__c is not Tomco Painting.
 *
 * The importer showed, from Salesforce: the name, the GC, the stage, the
 * close date, the bid on an open deal, the contract and change orders on a
 * sold one, and the work-order number.
 *
 * Every one of those is a field below. A field that cannot be compared on a
 * deal (a contract on an unsold one, an owner on a deal nobody here created)
 * is `n/a` with the reason, never silently "agree".
 */

export const RECONCILE_FIELDS = [
  "live_here",
  "corporate_name",
  "record_type",
  "external_id",
  "stage",
  "contract",
  "base",
  "change_orders",
  "account",
  "name",
  "close_date",
  "owner",
  "quote",
  "job_number",
  "bid",
] as const;
export type ReconcileField = (typeof RECONCILE_FIELDS)[number];

export type FieldVerdict = {
  field: ReconcileField;
  status: "agree" | "differ" | "n/a";
  /**
   * Does a difference here FAIL the reconciliation?
   *
   * True for everything a write path owns or the money depends on. False only
   * for the labels nothing syncs after the record exists — the name, the bid,
   * the work-order number, and the quote on a sale built in Salesforce — which
   * are reported, deal by deal, but cannot be "fixed" by the write-back without
   * a new kind of Salesforce write nobody has approved.
   */
  binding: boolean;
  ours: string;
  theirs: string;
  /** Why it is n/a, or what the difference means. */
  note?: string;
};

export type OursForReconcile = {
  id: string;
  /** `derivedOppName` — the name every surface here prints and the write-back sends. */
  name: string;
  deleted: boolean;
  sold: boolean;
  /** Closed and not won here (lost, no-bid). */
  closedUnsold: boolean;
  baseCents: number | null;
  /** Live approved change orders, the migrated rollup rows INCLUDED — they stand for Salesforce money. */
  approvedCoCents: number;
  bidCents: number | null;
  /** YYYY-MM-DD of `decided_at`, or null. */
  decidedOn: string | null;
  accountId: string | null;
  accountName: string | null;
  jobNumber: string | null;
};

export type SfForReconcile = {
  id: string;
  name: string;
  stageName: string;
  isClosed: boolean;
  isWon: boolean;
  closeDate: string | null;
  accountName: string | null;
  /** Our LIVE account row the import map ties Salesforce's AccountId to, if any. */
  ourAccountIdForSfAccount: string | null;
  /** The import map ties Salesforce's account to a row that has since been deleted here. */
  sfAccountLinkStale?: boolean;
  ownerName: string | null;
  recordType: string | null;
  corporateName: string | null;
  externalId: string | null;
  syncedQuoteId: string | null;
  quoteSubtotal: number | null;
  canonical: number | null;
  /** Sum of APPROVED ChangeOrder__c on the opportunity's live work orders, in cents. */
  approvedCoCents: number;
  workOrderNumbers: string[];
  quotes: Array<{ status: string; lines: number; lineAmounts: number[] }>;
};

export const TOMCO_CORPORATE_NAME = "Tomco Painting";
export const TOMCO_RECORD_TYPE = "Tomco";
export const TOMCO_OWNER = "Brendan Tomco";

/** Dollars from Salesforce to integer cents. Never compare floats. */
export const sfCents = (d: number | null | undefined): number | null =>
  d === null || d === undefined || !Number.isFinite(Number(d)) ? null : Math.round(Number(d) * 100);

export const fmtCents = (c: number | null | undefined): string =>
  c === null || c === undefined
    ? "—"
    : `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const norm = (s: string | null | undefined) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The stage, in words both sides can be compared in. */
export function ourStageWord(o: Pick<OursForReconcile, "sold" | "closedUnsold">): "sold" | "closed, not sold" | "open" {
  return o.sold ? "sold" : o.closedUnsold ? "closed, not sold" : "open";
}
export function sfStageWord(s: Pick<SfForReconcile, "stageName" | "isClosed" | "isWon">): "sold" | "closed, not sold" | "open" {
  /*
   * `StageName = 'Closed Won'`, the literal string, is what every Closed Won
   * automation in the org keys on (BUSINESS_RULES "The Closed Won cascade") —
   * not `IsWon`. They agree today; if they ever stop agreeing, the stage word
   * follows the string the org acts on.
   */
  if (s.stageName === "Closed Won") return "sold";
  return s.isClosed ? "closed, not sold" : "open";
}

/** The labels no write path keeps in step once the record exists. */
export const INFORMATIONAL_FIELDS: ReadonlySet<ReconcileField> = new Set(["name", "job_number", "bid"]);

export function reconcileDeal(
  ours: OursForReconcile,
  sf: SfForReconcile,
  opts: {
    /** The write-back built this opportunity (import-map note). */
    createdByWriteBack: boolean;
    /**
     * The write-back moved this opportunity to Closed Won — `sf_writes_audit`
     * holds the StageName write, or the write-back created it Closed Won.
     */
    closedByWriteBack: boolean;
  },
): FieldVerdict[] {
  const v: FieldVerdict[] = [];
  const push = (field: ReconcileField, status: FieldVerdict["status"], o: string, t: string, note?: string, binding?: boolean) =>
    v.push({ field, status, binding: binding ?? !INFORMATIONAL_FIELDS.has(field), ours: o, theirs: t, ...(note ? { note } : {}) });
  const bothSold = ours.sold && sfStageWord(sf) === "sold";

  // ── still a deal here at all ─────────────────────────────────────────────
  push(
    "live_here",
    ours.deleted ? "differ" : "agree",
    ours.deleted ? "deleted" : "live",
    "live",
    ours.deleted ? "deleted here; Salesforce still holds the opportunity — a person decides what happens there" : undefined,
  );

  // ── the two that decide whether it is Tomco's record at all ──────────────
  push("corporate_name", sf.corporateName === TOMCO_CORPORATE_NAME ? "agree" : "differ", TOMCO_CORPORATE_NAME, sf.corporateName ?? "unset");
  push("record_type", sf.recordType === TOMCO_RECORD_TYPE ? "agree" : "differ", TOMCO_RECORD_TYPE, sf.recordType ?? "unset");

  /*
   * UniqueExternalId__c. Empty is fine — the 140 links mostly came from the
   * importer, which keyed on Salesforce's own id — and is counted separately so
   * the number stamped is visible. Carrying a DIFFERENT deal's id is the one
   * wrong state: two deals here would both believe they own that sale.
   */
  if (!sf.externalId) push("external_id", "agree", ours.id, "unset", "not stamped (linked by the import map)");
  else push("external_id", sf.externalId === ours.id ? "agree" : "differ", ours.id, sf.externalId);

  // ── the stage ────────────────────────────────────────────────────────────
  {
    const o = ourStageWord(ours);
    const t = sfStageWord(sf);
    push("stage", o === t ? "agree" : "differ", o, `${t} (${sf.stageName})`);
  }

  // ── money, on a sale both sides call a sale ──────────────────────────────
  if (bothSold) {
    const canon = sfCents(sf.canonical) ?? 0;
    const oursTotal = Number(ours.baseCents ?? 0) + ours.approvedCoCents;
    push("contract", oursTotal === canon ? "agree" : "differ", fmtCents(oursTotal), fmtCents(canon));
    const sfBase = canon - sf.approvedCoCents;
    push("base", Number(ours.baseCents ?? 0) === sfBase ? "agree" : "differ", fmtCents(ours.baseCents ?? 0), fmtCents(sfBase));
    push(
      "change_orders",
      ours.approvedCoCents === sf.approvedCoCents ? "agree" : "differ",
      fmtCents(ours.approvedCoCents),
      fmtCents(sf.approvedCoCents),
    );
    if (opts.closedByWriteBack) {
      /*
       * Katie, 2026-09-22 and 2026-10-14: set on create, never updated — and
       * the org's own Closed Won flow stamps TODAY on the transition, whatever
       * was sent. So on a sale the write-back closed, Salesforce's date is the
       * day of the sync by design, and comparing it to the day it was won here
       * reports the policy as a defect.
       */
      push("close_date", "n/a", ours.decidedOn ?? "unset", sf.closeDate ?? "unset", "closed in Salesforce by the write-back — the org stamps the sync day, and Katie's rule is that it is never updated");
    } else {
      push(
        "close_date",
        ours.decidedOn && ours.decidedOn === sf.closeDate ? "agree" : "differ",
        ours.decidedOn ?? "unset",
        sf.closeDate ?? "unset",
      );
    }
  } else {
    const why = "not a sale on both sides — no contract to compare";
    for (const f of ["contract", "base", "change_orders", "close_date"] as const) push(f, "n/a", "—", "—", why);
  }

  // ── the GC ───────────────────────────────────────────────────────────────
  if (sf.ourAccountIdForSfAccount) {
    push(
      "account",
      sf.ourAccountIdForSfAccount === ours.accountId ? "agree" : "differ",
      ours.accountName ?? "none",
      sf.accountName ?? "none",
      sf.ourAccountIdForSfAccount === ours.accountId ? undefined : "linked to a different GC here than Salesforce's",
    );
  } else {
    /*
     * Not linked by the import map (a GC created here), or linked to a GC row
     * that has since been deleted here. The write-back resolves an account by
     * name with SOQL `=`, which is case-insensitive, so that is the comparison.
     */
    push(
      "account",
      norm(ours.accountName) === norm(sf.accountName) && !!sf.accountName ? "agree" : "differ",
      ours.accountName ?? "none",
      sf.accountName ?? "none",
      sf.sfAccountLinkStale ? "the GC row the import map links to Salesforce's account was deleted here; compared by name" : undefined,
    );
  }

  // ── the name ─────────────────────────────────────────────────────────────
  push("name", ours.name.trim() === String(sf.name ?? "").trim() ? "agree" : "differ", ours.name, sf.name);

  // ── the owner: the write-back sets it only on what it creates ────────────
  if (opts.createdByWriteBack) {
    push("owner", sf.ownerName === TOMCO_OWNER ? "agree" : "differ", TOMCO_OWNER, sf.ownerName ?? "unset");
  } else {
    push("owner", "n/a", "—", sf.ownerName ?? "unset", "created in Salesforce, not by the write-back — its owner is Salesforce's to keep");
  }

  // ── the quote ────────────────────────────────────────────────────────────
  if (bothSold) {
    const approved = sf.quotes.filter((q) => q.status === "Approved");
    const base = Number(ours.baseCents ?? 0);
    if (opts.createdByWriteBack) {
      /*
       * Ours end to end, so it must be exactly the shape Katie asked for:
       * one quote, Approved, one line carrying the base, synced.
       */
      const q = sf.quotes[0];
      const ok =
        sf.quotes.length === 1 &&
        q.status === "Approved" &&
        q.lines === 1 &&
        sfCents(q.lineAmounts[0]) === base &&
        !!sf.syncedQuoteId;
      push(
        "quote",
        ok ? "agree" : "differ",
        `1 approved quote, 1 line ${fmtCents(base)}, synced`,
        `${sf.quotes.length} quote(s) [${sf.quotes.map((x) => `${x.status}/${x.lines} line`).join(", ")}], ${sf.syncedQuoteId ? "synced" : "NOT synced"}, line ${fmtCents(sfCents(sf.quoteSubtotal))}`,
      );
    } else {
      /*
       * Built in Salesforce. The write-back leaves a won quote alone, and the
       * canonical total (compared above) is the figure that matters; what has
       * to hold is that the sale HAS an approved quote.
       */
      push(
        "quote",
        approved.length > 0 ? "agree" : "differ",
        "an approved quote",
        `${sf.quotes.length} quote(s), ${approved.length} approved`,
        sfCents(sf.quoteSubtotal) === base ? undefined : `its quote line reads ${fmtCents(sfCents(sf.quoteSubtotal))} against our base ${fmtCents(base)}`,
        // Salesforce's own history; the write-back leaves a won quote alone.
        false,
      );
    }
  } else {
    push("quote", "n/a", "—", `${sf.quotes.length} quote(s)`, "not a sale on both sides", !!opts.createdByWriteBack);
  }

  // ── the work-order number the platform carries ───────────────────────────
  if (!ours.jobNumber && sf.workOrderNumbers.length === 0) push("job_number", "agree", "none", "none");
  else if (!ours.jobNumber) push("job_number", sf.workOrderNumbers.length && !ours.sold ? "n/a" : "differ", "none", sf.workOrderNumbers.join(", "), sf.workOrderNumbers.length && !ours.sold ? "not sold here" : undefined);
  else push("job_number", sf.workOrderNumbers.includes(ours.jobNumber) ? "agree" : "differ", ours.jobNumber, sf.workOrderNumbers.join(", ") || "none");

  // ── the bid, on a deal open on both sides ────────────────────────────────
  if (ourStageWord(ours) === "open" && sfStageWord(sf) === "open") {
    const theirs = sfCents(sf.quoteSubtotal ?? sf.canonical);
    push("bid", Number(ours.bidCents ?? 0) === Number(theirs ?? 0) ? "agree" : "differ", fmtCents(ours.bidCents), fmtCents(theirs));
  } else {
    push("bid", "n/a", "—", "—", "not an open bid on both sides");
  }
  return v;
}

/**
 * A difference somebody has looked at, pinned to its EXACT values.
 *
 * 🔴 PINNED, NOT COUNTED. The old mechanism was `differ.length <= 2`: any two
 * deals could differ and it passed, so a fresh drift on a third deal the day
 * the first was fixed would have read green. A known difference here matches
 * one deal, one field, and the exact figures on both sides — if either side
 * moves, it is a NEW difference and fails. If it goes away, that fails too,
 * until the entry is deleted: the list only shrinks on purpose.
 */
export type KnownDifference = {
  dealId: string;
  field: ReconcileField;
  ours: string;
  theirs: string;
  /** Which side is right and why, in a sentence somebody can act on. */
  reason: string;
  /** Who has to approve the correction. */
  owner: string;
};

export type Classified = {
  verdict: FieldVerdict;
  dealId: string;
  label: string;
  /**
   * `info` is a difference on a non-binding field: reported, never failing.
   * `NEW` is a difference on a binding field that no pinned entry explains.
   */
  kind: "agree" | "n/a" | "known" | "NEW" | "info" | "resolved-known";
  known?: KnownDifference;
};

export function classify(
  rows: Array<{ dealId: string; label: string; verdicts: FieldVerdict[] }>,
  known: KnownDifference[],
): { classified: Classified[]; staleKnown: KnownDifference[] } {
  const out: Classified[] = [];
  const used = new Set<KnownDifference>();
  for (const r of rows) {
    for (const v of r.verdicts) {
      const k = known.find((x) => x.dealId === r.dealId && x.field === v.field);
      if (v.status === "differ" && !v.binding && !k) {
        out.push({ verdict: v, dealId: r.dealId, label: r.label, kind: "info" });
      } else if (v.status === "differ") {
        if (k && k.ours === v.ours && k.theirs === v.theirs) {
          used.add(k);
          out.push({ verdict: v, dealId: r.dealId, label: r.label, kind: "known", known: k });
        } else {
          if (k) used.add(k);
          out.push({ verdict: v, dealId: r.dealId, label: r.label, kind: "NEW", ...(k ? { known: k } : {}) });
        }
      } else {
        if (k) {
          used.add(k);
          out.push({ verdict: v, dealId: r.dealId, label: r.label, kind: "resolved-known", known: k });
        } else out.push({ verdict: v, dealId: r.dealId, label: r.label, kind: v.status === "agree" ? "agree" : "n/a" });
      }
    }
  }
  // A known entry naming a deal that is not linked any more is stale too.
  const staleKnown = known.filter((k) => !used.has(k));
  return { classified: out, staleKnown };
}
