/**
 * AIA billing constants + the pure G702 summary math (Phase H). Client-safe —
 * no server imports — so the application UI can render the certificate lines
 * and the math can be unit-tested without a DB.
 */

export const AIA_APPLICATION_STATUSES = ["draft", "submitted", "paid"] as const;
export type AiaApplicationStatus = (typeof AIA_APPLICATION_STATUSES)[number];

export const AIA_STATUS_META: Record<
  AiaApplicationStatus,
  { label: string; tone: "charcoal" | "ppp-blue" | "emerald" }
> = {
  // Draft is neutral (not amber) — matches invoice/proposal draft across the
  // platform; amber is reserved for pending/warning states.
  draft: { label: "Draft", tone: "charcoal" },
  submitted: { label: "Submitted", tone: "ppp-blue" },
  paid: { label: "Paid", tone: "emerald" },
};

/** AIA's common default retainage. */
/**
 * The percentage a new job withholds when nobody has said otherwise.
 *
 * Tomco's contracts are usually 5 or 10, set by the GC. This is only the
 * fallback for the FIRST application on a job with no company default
 * configured — see `pickRetainagePct`, which carries the rate forward from the
 * job's own previous certificate so it is typed once, not once per month.
 */
export const DEFAULT_RETAINAGE_PCT = 5;

/** A percentage that is a real number inside 0-100. */
export function isUsableRetainagePct(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}

/**
 * WHICH PERCENTAGE A NEW CERTIFICATE WITHHOLDS AT.
 *
 * Karan, 2026-10-16: "make sure there's an easy way for us to change from 5 to
 * 10 percent." The rate is a contract term — this GC holds 10, that one holds
 * 5 — so the unit that matters is the JOB, and the way to make it easy is to
 * stop asking for it again on every certificate.
 *
 * Before this, every application fell back to a hardcoded 5 unless the
 * operator retyped the rate. On a 10% job that is a trap with no feedback:
 * miss it once and that certificate under-withholds by half, the G702 goes to
 * the GC wrong, and line 5 disagrees with every earlier certificate on the
 * same job. Nothing would have flagged it.
 *
 * The order, most specific first:
 *
 *   1. What the operator typed on this certificate — always wins.
 *   2. The job's own previous certificate. One deliberate exclusion: a
 *      RETAINAGE RELEASE runs at 0, and that zero is the release itself, not
 *      the job's rate. Inheriting it would silently stop withholding on every
 *      certificate after the first release — the most damaging version of
 *      this bug, and the one the Cipla sequence would hit, since that job
 *      bills, releases, bills again and releases again.
 *   3. The company-wide default from Settings → Operating Company.
 *   4. 5.
 *
 * `previous` may be passed unsorted and may include releases and drafts; a
 * draft counts here, because the rate someone is preparing at is a better
 * guess for the next one than a company default.
 */
export function pickRetainagePct(opts: {
  requested?: number | null;
  previous?: readonly { application_number: number; retainage_pct: number; is_retainage_release: boolean }[];
  companyDefault?: number | null;
}): number {
  if (isUsableRetainagePct(opts.requested)) return opts.requested;

  let latest: { application_number: number; retainage_pct: number } | null = null;
  for (const p of opts.previous ?? []) {
    if (p.is_retainage_release) continue;
    if (!isUsableRetainagePct(p.retainage_pct)) continue;
    if (!latest || p.application_number > latest.application_number) latest = p;
  }
  if (latest) return latest.retainage_pct;

  if (isUsableRetainagePct(opts.companyDefault)) return opts.companyDefault;
  return DEFAULT_RETAINAGE_PCT;
}

/** One G703 continuation-sheet line's inputs (all cents). */
export type AiaLineInput = {
  scheduled_value_cents: number;
  from_previous_cents: number;
  this_period_cents: number;
  materials_stored_cents: number;
  /** Optional so existing callers compile unchanged. Only the SALES TAX row
   *  needs to be identifiable here — see isAiaTaxLine and computeG702. */
  item_no?: string | null;
  /**
   * Work on THIS line whose retainage has ALREADY BEEN RELEASED, and so must
   * not be withheld a second time. Set by `applyReleasedRetainage`; absent
   * (the default) means nothing has been released and the math is unchanged.
   */
  retainage_released_cents?: number;
};

/**
 * 🔴 RETAINAGE IS WITHHELD ONCE. RELEASED WORK IS NOT RE-RETAINED.
 *
 * Stephanie, 2026-10-16, on LMJ Cipla — the job she calls "a billing
 * nightmare": billed in full, billed the retainage, got paid in full. Then a
 * change order arrived, so it had to be billed plus its retainage. Twice more.
 *
 *     "I am trying to record it in Command and it is pulling details from the
 *      paid retainage AIA and giving me negative numbers."
 *
 * Her Application 6 measured on the live row: $1,000 of new change-order work
 * on top of $87,627.09 already billed, retained AND released. Line 5 came back
 * $4,431.36 — five percent of the WHOLE contract, for the second time — so
 * line 6 landed $3,431.36 BELOW the previous certificate and line 8, the
 * figure the GC pays, read MINUS $3,431.36. On a document we send out.
 *
 * The rule is the one she wrote out herself: "$1000 CO, 5% ret, $950 due and
 * $50 ret, $50 balance to finish". Retainage applies to work not yet released,
 * which after a release application is the NEW work only.
 *
 * Carried PER LINE rather than as one total because G702 line 5 has to tie to
 * the G703's retainage column line for line (see computeG702), and because the
 * release is itself per line: a job can release on the base scope and still be
 * holding retainage on a change order billed after it.
 *
 * Clamped to the line's own sign and magnitude so a credit line still earns its
 * negative retainage downward, and so a stale or mismatched baseline can never
 * push a line's retainage past zero in the wrong direction.
 */
function releasedOn(l: AiaLineInput, earned: number): number {
  const rel = Math.round(l.retainage_released_cents ?? 0);
  if (rel === 0) return 0;
  return earned < 0 ? Math.min(0, Math.max(earned, rel)) : Math.max(0, Math.min(earned, rel));
}

/** Completed-and-stored on this line that retainage may still be withheld on. */
export function lineRetainableCents(l: AiaLineInput): number {
  const earned = lineCompletedStoredCents(l);
  return earned - releasedOn(l, earned);
}

/** Retainage on one G703 line — the per-line rounding G702 line 5 sums. */
export function lineRetainageCents(l: AiaLineInput, pct: number): number {
  const p = Math.min(100, Math.max(0, pct));
  return Math.round((lineRetainableCents(l) * p) / 100);
}

/**
 * The COMPLETED (G703 columns D + E) half of the retainable base, for the
 * G702's 5a/5b split. Released work is the oldest work on the line, so it
 * comes off completed before it comes off materials stored.
 */
export function lineRetainableCompletedCents(l: AiaLineInput): number {
  const de = Math.round(l.from_previous_cents) + Math.round(l.this_period_cents);
  return de - releasedOn(l, de);
}

/** The columns that identify one G703 line across a deal's applications. */
export type AiaLineIdentity = {
  /** The row's own id. Only read as the ROOT of a chain — see `aiaLineRootId`. */
  id?: string | null;
  /**
   * The line this one was carried forward from, as the root of the chain: the
   * FIRST application's row, stamped by `seedAiaScheduleOfValues` from
   * `prior.source_line_id ?? prior.id`. Null on rows seeded before the column
   * existed, and absent entirely until its migration is applied.
   */
  source_line_id?: string | null;
  item_no?: string | null;
  description?: string | null;
  change_order_id?: string | null;
  position?: number | null;
};

/**
 * `item_no` as a person means it, not as they happened to type it.
 *
 * The number is free text on the screen, so "1", "01", "1." and " 1 " are the
 * same line to the operator and four different lines to an exact match — and a
 * line that stops matching the release sheet loses the retainage that release
 * already let go. Changing "1" to "01" on a carried-forward line put $4,025.00
 * of retainage back on a line that should hold $575.00.
 *
 * Deliberately narrow: case, whitespace, a trailing full stop and leading
 * zeros. Anything looser ("1A" is "1"?) is a guess that two lines are one, and
 * a wrong guess pools two lines' released work into one.
 */
export function normaliseAiaItemNo(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\.+$/, "")
    .replace(/^0+(?=\d)/, "");
}

/**
 * A G703 line's identity across applications, from what it SAYS.
 * `seedAiaScheduleOfValues` copies `item_no`, `description` and
 * `change_order_id` verbatim when it carries a sheet forward, so these tie a
 * line to its earlier self; `position` is the last resort for a hand-added row
 * with neither. Everything here but the change order can be typed over, which
 * is why `applyReleasedRetainage` tries `aiaLineRootId` first.
 */
export function aiaLineIdentityKey(l: AiaLineIdentity): string {
  if (l.change_order_id) return `co:${l.change_order_id}`;
  const no = normaliseAiaItemNo(l.item_no);
  if (no) return `no:${no}`;
  const d = (l.description ?? "").trim().replace(/\s+/g, " ");
  if (d) return `d:${d.toLowerCase()}`;
  return `p:${l.position ?? ""}`;
}

/**
 * The identity nobody can type over: the first row of the chain this line was
 * carried forward from, or the row itself when it starts one.
 */
export function aiaLineRootId(l: AiaLineIdentity): string | null {
  return l.source_line_id || l.id || null;
}

/** The fields the release rule below reads off an application row. */
export type AiaReleaseCandidate = {
  id: string;
  application_number: number;
  status: string;
  is_retainage_release: boolean;
};

/**
 * WHICH release application a certificate reads its baseline from.
 *
 * ONE rule, because there were two and they were separately maintained.
 * `listAiaLineItemsWithRelease` expressed it as a Postgres query —
 * `is_retainage_release`, `.lt(application_number)`, status in
 * (submitted, paid), `deleted_at is null`, order desc, limit 1 — and
 * `aiaBillingRollupBulk` re-expressed the same sentence as a JS loop over rows
 * it had already fetched. They agreed on 2026-10-16 when both were read
 * side by side. Nothing made them agree.
 *
 * That matters more than it sounds: the SQL one prints the G702 the GC pays
 * from, the JS one feeds AR aging, the emailed statement, receivables, Account
 * 360, the deal page and the assistant. A clause added to one and not the other
 * is a platform that disagrees with its own paperwork, and on LMJ Cipla the
 * cost of getting the baseline wrong is $4,381.36.
 *
 * So the selection lives here, in the pure module both sides already import,
 * and the query's job shrinks to FETCHING the candidates. Deleted rows are
 * still excluded in SQL — that is a storage concern and both callers do it.
 *
 * A tie on `application_number` cannot happen while the partial unique index
 * holds, but `limit 1` answered it arbitrarily and a loop answered it by
 * insertion order. Lowest `id` wins, so the two can no longer differ even in
 * the case that should not arise.
 */
export function pickReleaseApplication<T extends AiaReleaseCandidate>(
  candidates: readonly T[],
  beforeApplicationNumber: number
): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (!c.is_retainage_release) continue;
    if (c.status !== "submitted" && c.status !== "paid") continue;
    if (c.application_number >= beforeApplicationNumber) continue;
    if (
      !best ||
      c.application_number > best.application_number ||
      (c.application_number === best.application_number && c.id < best.id)
    ) {
      best = c;
    }
  }
  return best;
}

/** What an application carries about its OWN release baseline (migration
 *  20261016200000). Both absent until that migration is applied. */
export type AiaReleaseBaselinePin = {
  status?: string | null;
  application_number: number;
  release_baseline_app_id?: string | null;
  release_baseline_pinned_at?: string | null;
};

/**
 * The release a certificate reads its baseline from — PINNED once it is issued.
 *
 * `pickReleaseApplication` chooses by application_number, and the number is
 * the one field on an issued certificate that stays editable (it is how the GC
 * files it). So renumbering a release past a certificate already paid moved
 * that certificate's baseline: on LMJ Cipla, sliding release #5 above #6 takes
 * #6's line 5 from $50.00 to $4,431.36 on a document the GC has paid.
 *
 * Issuing stamps the release the rule chose at that moment, and from then on
 * the stamp answers, whatever the numbers do. A stamped null means "there was
 * no release", which is why the timestamp, not the id, says it was pinned. A
 * draft, or a certificate issued before the stamp existed, still goes through
 * the rule — and `updateAiaApplication` refuses the renumber that would move
 * one of those.
 *
 * The pinned release still has to be a live, issued release in `candidates`:
 * a draft release has released nothing, and a deleted one is not a document.
 */
export function releaseBaselineFor<T extends AiaReleaseCandidate>(
  app: AiaReleaseBaselinePin,
  candidates: readonly T[]
): T | null {
  if (app.status && app.status !== "draft" && app.release_baseline_pinned_at) {
    const id = app.release_baseline_app_id;
    if (!id) return null;
    return (
      candidates.find(
        (c) => c.id === id && c.is_retainage_release && (c.status === "submitted" || c.status === "paid")
      ) ?? null
    );
  }
  return pickReleaseApplication(candidates, app.application_number);
}

/**
 * The ISSUED certificates whose release baseline would move if `appId` took
 * `newNumber` — empty when the renumber is safe.
 *
 * The interim half of the F6 fix, and it stays useful after the pin lands: a
 * certificate issued before the stamp existed has nothing pinned, so its
 * baseline is still whatever the numbers say. Every live application on the
 * deal goes in, releases and ordinary ones alike, because both directions
 * break: a release slid ABOVE a paid certificate un-releases it, and a paid
 * certificate slid BELOW a release loses the release it was issued against.
 *
 * Shifting a whole series in order (1,2,3 to 3,4,5, top first), which is what
 * Stephanie asked renumbering for, keeps every release where it was relative
 * to its certificates, and comes back empty.
 */
export function certificatesRestatedByRenumber<T extends AiaReleaseCandidate & AiaReleaseBaselinePin>(
  apps: readonly T[],
  appId: string,
  newNumber: number
): T[] {
  const after = apps.map((a) => (a.id === appId ? { ...a, application_number: newNumber } : a));
  const out: T[] = [];
  apps.forEach((a, i) => {
    if (a.status !== "submitted" && a.status !== "paid") return;
    const was = releaseBaselineFor(a, apps)?.id ?? null;
    const now = releaseBaselineFor(after[i], after)?.id ?? null;
    if (was !== now) out.push(a);
  });
  return out;
}

/**
 * Stamp `retainage_released_cents` on each line from the schedule of the
 * application that RELEASED retainage (`is_retainage_release`, which forces
 * its rate to 0 — that zero IS the release, so everything completed through it
 * came out from under retainage).
 *
 * Lines the release sheet does not carry — a change order added after it, which
 * is the whole point of Stephanie's case — get nothing, and are retained in
 * full. Returns new objects; the inputs are untouched.
 */
export function applyReleasedRetainage<T extends AiaLineInput & AiaLineIdentity>(
  lines: T[],
  releaseLines: readonly (AiaLineInput & AiaLineIdentity)[] | null | undefined
): T[] {
  if (!releaseLines || releaseLines.length === 0) return lines;
  /*
   * MATCHED BY CHAIN FIRST, BY WHAT IT SAYS SECOND.
   *
   * A release line and a later line that share a root ARE the same line,
   * whatever anyone has since typed into item_no or the description. Only
   * lines with no shared root — everything seeded before `source_line_id`
   * existed — fall back to `aiaLineIdentityKey`. A release line claimed by a
   * root is out of the fallback pool, so a renamed line and a namesake can
   * never both claim it.
   */
  const lineRoots = new Set(lines.map(aiaLineRootId).filter((x): x is string => !!x));
  const sharedRoots = new Set<string>();
  const pool = new Map<string, number>();
  for (const r of releaseLines) {
    const root = aiaLineRootId(r);
    const shared = !!root && lineRoots.has(root);
    if (shared) sharedRoots.add(root!);
    const k = shared ? `root:${root}` : aiaLineIdentityKey(r);
    pool.set(k, (pool.get(k) ?? 0) + lineCompletedStoredCents(r));
  }
  return lines.map((l) => {
    const root = aiaLineRootId(l);
    const k = root && sharedRoots.has(root) ? `root:${root}` : aiaLineIdentityKey(l);
    const available = pool.get(k);
    if (available === undefined || available === 0) return l;
    // Two lines sharing a key split the released amount rather than each
    // claiming all of it.
    const earned = lineCompletedStoredCents(l);
    const take = earned < 0 ? Math.min(0, Math.max(earned, available)) : Math.max(0, Math.min(earned, available));
    pool.set(k, available - take);
    return { ...l, retainage_released_cents: take };
  });
}

/** The computed G702 certificate summary (all cents). */
export type AiaG702 = {
  /** 1 — Original Contract Sum. */
  originalContractCents: number;
  /** 2 — Net change by approved Change Orders (Phase G). */
  netChangeOrdersCents: number;
  /** Sales tax on this contract, when the job is taxable. Its own component of
   *  line 3 rather than part of line 1, so a certificate arriving mid-job takes
   *  the tax off WITHOUT restating the contract the GC signed. */
  salesTaxCents: number;
  /** 3 — Contract Sum to Date = (1) + (2) + sales tax. */
  contractSumToDateCents: number;
  /** 4 — Total Completed & Stored to Date = Σ (D + E + F). */
  totalCompletedStoredCents: number;
  /** 5 — Retainage = retainagePct% of (4). */
  retainageCents: number;
  /** 6 — Total Earned Less Retainage = (4) − (5). */
  totalEarnedLessRetainageCents: number;
  /** 7 — Less Previous Certificates for Payment (prior period's line 6). */
  previousCertificatesCents: number;
  /** 8 — Current Payment Due = (6) − (7). */
  currentPaymentDueCents: number;
  /**
   * How far line 3 sits from the G703 grand total (line 3 − Σ scheduled value).
   *
   * AIA's footing rule is that the continuation sheet's scheduled-value column
   * totals to the contract sum on the cover sheet. Nothing in the data model
   * enforces it: the G703 is written once at seed while lines 1 and 2 track the
   * deal, so an approved change order pushes them apart. Non-zero here means the
   * certificate does not add up — a GC's accounts-payable system can reject it —
   * so it is reported rather than quietly tolerated.
   */
  sovVarianceCents: number;
  /** 9 — Balance to Finish incl. Retainage = (3) − (6). */
  balanceToFinishCents: number;
  /** % of contract completed = (4) / (3). Null when contract sum is 0. */
  percentCompleteBps: number | null;
};

/**
 * Cumulative completed + stored for one G703 line (columns D + E + F).
 *
 * A CREDIT line — a deductive change order, whose scheduled value is negative —
 * earns DOWNWARD. The floor at zero was applied to every line, so a deduct row
 * was stuck at 0 no matter what: its scope came off the contract sum (line 3)
 * but never came off the completed total (line 4), so a job billed to 100% of
 * its remaining lines reported over 100% complete, a negative balance to
 * finish, and a final payment due that included the descoped work. The customer
 * gets billed for the thing they removed.
 *
 * So the clamp follows the SIGN of the line: a normal line can't go below zero,
 * a credit line can't go above it. Neither can drift past its own scheduled
 * value in the wrong direction, which is what the clamp was protecting against.
 */
export function lineCompletedStoredCents(l: AiaLineInput): number {
  // Clamped PER COLUMN, not on the sum — a stray negative in one column must
  // not reduce the others (that was the original rule and it still holds).
  const credit = Math.round(l.scheduled_value_cents) < 0;
  const fit = (v: number) => (credit ? Math.min(0, v) : Math.max(0, v));
  return (
    fit(Math.round(l.from_previous_cents)) +
    fit(Math.round(l.this_period_cents)) +
    fit(Math.round(l.materials_stored_cents))
  );
}

/**
 * Pure G702 computation. Every input is cents; retainagePct is a percent (5 =
 * 5%); netChangeOrdersCents is the signed net of approved COs; prevCertsCents
 * is the immediately-prior application's Total Earned Less Retainage (line 6),
 * i.e. the AIA carry-forward.
 */
export function computeG702({
  originalContractCents,
  netChangeOrdersCents,
  retainagePct,
  lines,
  previousCertificatesCents,
}: {
  originalContractCents: number;
  netChangeOrdersCents: number;
  retainagePct: number;
  lines: AiaLineInput[];
  previousCertificatesCents: number;
}): AiaG702 {
  // Sales tax is read off its own G703 row, so line 3 and the schedule always
  // agree — sovVarianceCents exists precisely to catch them drifting apart, and
  // adding tax to one side only is how that would happen.
  const salesTaxCents = lines
    .filter((l) => isAiaTaxLine(l))
    .reduce((sum, l) => sum + Math.round(l.scheduled_value_cents), 0);
  const contractSumToDate = originalContractCents + netChangeOrdersCents + salesTaxCents;
  const sovTotal = lines.reduce(
    // NOT clamped at zero: a deductive change order is a real, negative line
    // on a real schedule of values, and dropping it here would make the sheet
    // total more than the contract it is supposed to foot to.
    (sum, l) => sum + Math.round(l.scheduled_value_cents),
    0
  );
  const totalCompletedStored = lines.reduce((sum, l) => sum + lineCompletedStoredCents(l), 0);
  const pct = Math.min(100, Math.max(0, retainagePct));
  // Retainage (G702 line 5) is the SUM of PER-LINE rounded retainage — the same
  // way the G703 continuation sheet's retainage column totals — so the two
  // sheets always tie to the penny. (Rounding the total instead of per-line
  // drifts by ~N/2 cents and a GC's AP system can reject the mismatch.)
  //
  // Per-line is also what lets a job hold retainage on a change order billed
  // AFTER a release while holding none on the scope the release covered — see
  // `lineRetainableCents` for why that is not a refinement but the difference
  // between line 8 and minus line 8.
  const retainage = lines.reduce((sum, l) => sum + lineRetainageCents(l, pct), 0);
  const totalEarnedLessRetainage = totalCompletedStored - retainage;
  const currentPaymentDue = totalEarnedLessRetainage - previousCertificatesCents;
  const balanceToFinish = contractSumToDate - totalEarnedLessRetainage;
  const percentCompleteBps =
    contractSumToDate > 0
      ? Math.round((totalCompletedStored / contractSumToDate) * 10000)
      : null;
  return {
    originalContractCents,
    netChangeOrdersCents,
    salesTaxCents,
    contractSumToDateCents: contractSumToDate,
    totalCompletedStoredCents: totalCompletedStored,
    retainageCents: retainage,
    totalEarnedLessRetainageCents: totalEarnedLessRetainage,
    previousCertificatesCents,
    currentPaymentDueCents: currentPaymentDue,
    balanceToFinishCents: balanceToFinish,
    percentCompleteBps,
    sovVarianceCents: contractSumToDate - sovTotal,
  };
}

/**
 * Collapse a deal's AIA payment applications into the two figures the deal's
 * financial rollups need — so an AIA-billed job stops reading "$0 billed"
 * (Phase D, Karan 2026-08-14). AIA is a SEPARATE billing ledger from
 * `commercial_invoices`; the deal financials sum only invoices, so AIA revenue
 * was invisible to the P&L, margin, delivery Billing stage, Account 360, and the
 * dashboard.
 *
 * Definitions (standard AIA accounting):
 *   - **billed** = the LATEST issued (submitted/paid) application's cumulative
 *     "Total Completed & Stored to date" (G702 line 4). That is the GROSS value
 *     of work certified to the GC — pre-retainage, directly comparable to the
 *     contract sum (also gross), matching how a regular invoice's pre-tax
 *     subtotal is "billed". Retainage is a payment-timing withholding, not a
 *     reduction in what was billed, so it stays IN this number.
 *   - **collected** = the LATEST PAID application's cumulative "Total Earned Less
 *     Retainage" (G702 line 6). AIA payment is sequential — paying application N
 *     settles everything earned-less-retainage through N — so the latest paid
 *     app's line 6 IS the cash collected to date (net of retainage). Retainage
 *     held stays uncollected, so `billed − collected` correctly carries it (plus
 *     any submitted-but-unpaid amount) as outstanding.
 *
 * Both figures are the cumulative line off ONE application each, so this works
 * identically for the single-deal detail path AND the batch (listProjects) path
 * — no per-application summing that the two surfaces could drift on.
 *
 * Pure so the money logic is unit-tested away from the DB; the async wrapper in
 * db.ts just resolves the two G702s and calls this.
 */
export function aiaBilledCollectedFrom(input: {
  /** G702 of the latest ISSUED (submitted/paid) application → billed. */
  latestIssued: Pick<
    AiaG702,
    "totalCompletedStoredCents" | "totalEarnedLessRetainageCents"
  > | null;
  /** G702 of the latest PAID application → collected. Null when nothing paid. */
  latestPaid: Pick<AiaG702, "totalEarnedLessRetainageCents"> | null;
}): {
  billedCents: number;
  collectedCents: number;
  /** G702 line 6 on the latest issued app — the part of `billed` the GC is
   *  contractually obliged to pay NOW. */
  earnedLessRetainageCents: number;
  /** billed − earned-less-retainage. Owed eventually, at close-out. */
  retainageHeldCents: number;
  /** THE AR FIGURE: earned-less-retainage minus what's been collected. */
  dueNowCents: number;
} {
  const billedCents = Math.max(0, input.latestIssued?.totalCompletedStoredCents ?? 0);
  // Line 6 can't exceed line 4; a bad import shouldn't produce negative retainage.
  const earnedLessRetainageCents = Math.min(
    billedCents,
    Math.max(0, input.latestIssued?.totalEarnedLessRetainageCents ?? 0)
  );
  const retainageHeldCents = Math.max(0, billedCents - earnedLessRetainageCents);
  const collectedRaw = Math.max(0, input.latestPaid?.totalEarnedLessRetainageCents ?? 0);
  // Never report more collected than billed (a data glitch shouldn't invent
  // negative outstanding on the CEO's dashboard).
  const collectedCents = Math.min(collectedRaw, billedCents);
  return {
    billedCents,
    collectedCents,
    earnedLessRetainageCents,
    retainageHeldCents,
    // NET OF RETAINAGE (decided 2026-08-17, docs/AIA_FINANCIALS_INTEGRATION.md).
    // Retainage is not payable until close-out, so counting it as receivable
    // would (a) overstate what any GC would acknowledge owing and (b) poison
    // the aging report — retainage sits for months BY DESIGN, so every AIA job
    // would read 90+ days past due and the report would stop meaning anything.
    // Construction accounting splits "AR — Trade" from "Retainage Receivable"
    // for exactly this reason. Retainage is carried separately, never dropped.
    dueNowCents: Math.max(0, earnedLessRetainageCents - collectedCents),
  };
}

/**
 * Is this G703 line a CHANGE ORDER line (G702 line 2), rather than base contract
 * work (line 1)?
 *
 * Tagged either by `change_order_id` (migration 128) or, for rows seeded before
 * that FK column existed (no backfill), by the `CO-###` item_no the seed used.
 * ONE definition so "base schedule-of-values total" means the same thing on the
 * seed snap, the live certificate, the App-2 carry-forward, and the portfolio
 * rollup — feeding a CO-inclusive SOV to the contract-base ladder is exactly
 * what double-counted every change order on line 3 (audit M2).
 */
export function isAiaChangeOrderLine(line: {
  change_order_id?: string | null;
  item_no?: string | null;
}): boolean {
  return !!line.change_order_id || /^CO-0*\d+$/i.test(line.item_no ?? "");
}

/**
 * The sales-tax row on the schedule of values.
 *
 * Stephanie 2026-09-01: "The sales tax needs to appear within the totals of the
 * scheduled values. With that, if we change the sales tax status because they
 * provided a cert later into the job if not after, we need the status to change
 * the values within the AIA."
 *
 * Its OWN row, deliberately, rather than folded into the contract. Her second
 * sentence is the reason: a cert can arrive mid-job, and the tax then has to
 * come off. If tax lived inside line 1, removing it would restate the Original
 * Contract Sum — telling the GC the contract changed when it did not. That is
 * the same confusion she described with alternates surfacing as change orders,
 * and it is the thing to avoid.
 *
 * So tax behaves like a change order in the arithmetic: outside the original
 * contract base, inside the contract sum to date. Line 1 stays the number they
 * signed, and the tax can go to zero without touching it.
 */
export const AIA_TAX_ITEM_NO = "TAX";

export function isAiaTaxLine(line: { item_no?: string | null }): boolean {
  return (line.item_no ?? "").trim().toUpperCase() === AIA_TAX_ITEM_NO;
}

/**
 * The ONE contract-base ladder, shared by the Projects card, the Account 360
 * production KPIs, the AIA G702 (via resolveG702), and the Change Orders page —
 * so all four always agree on "contract to date" for a deal. Once an AIA app
 * exists, its explicit snapshotted contract wins, else its schedule-of-values
 * total (which by AIA convention IS the contract sum); before any billing, the
 * deal's bid midpoint. Approved change orders are added on TOP of this base by
 * the caller.
 */
export function pickContractBaseCents(opts: {
  hasBillingApp: boolean;
  originalContractCents: number;
  sovTotalCents: number;
  /** Total of the ACCEPTED (won) proposal — the signed contract number. */
  acceptedProposalCents?: number;
  /**
   * The contract sum a PERSON typed on this application.
   *
   * Ranked above everything, including a won proposal, because someone typing
   * here is correcting the number the ladder would otherwise pick — a
   * negotiated figure, a legacy job, a correction from the GC. The field saved
   * and was then discarded, which is worse than not offering it.
   */
  manualContractCents?: number;
  /**
   * The signed contract REMEMBERED ON THE DEAL (`accepted_contract_cents`).
   *
   * Needed because winning is recorded on the proposal, and creating a revision
   * supersedes it — so the moment an estimator re-quotes a won job, no proposal
   * reads `won` and the fact that $450k was signed disappears from the
   * proposals table entirely. The deal remembers it instead.
   */
  acceptedSnapshotCents?: number;
  /** Total of the LATEST proposal the customer has actually SEEN or decided on
   *  (highest revision among sent/won/lost/expired/superseded), used when no
   *  proposal is won yet — so the contract tracks the most recent real quote,
   *  never the first one. */
  latestProposalCents?: number;
  /**
   * Total of the latest PRE-SEND proposal (draft / pending approval / approved).
   *
   * The bottom rung, below even the bid midpoint. A number nobody outside the
   * office has seen must never outrank one they have — but it beats showing a
   * deal no contract at all, which is what happened once the bid low/high fields
   * were dropped from the create forms and `bidMidCents` became 0 for most deals.
   */
  pendingProposalCents?: number;
  bidMidCents: number;
}): number {
  // Karan 2026-08 (smoke-test fix): a WON proposal IS the signed contract and
  // must drive the contract EVERYWHERE — never the first proposal, never a stale
  // AIA original_contract seeded from an old bid. So the proposal sits at the
  // TOP of the ladder: won first, then the latest proposal if none is won yet.
  if (opts.manualContractCents && opts.manualContractCents > 0) return opts.manualContractCents;
  if (opts.acceptedProposalCents && opts.acceptedProposalCents > 0) return opts.acceptedProposalCents;
  // The remembered signed contract, for a won deal whose winning proposal was
  // superseded by a re-quote. Below the live `won` total on purpose: if a
  // proposal says `won` right now, that is the better answer, and re-winning a
  // deal re-writes the snapshot anyway.
  if (opts.acceptedSnapshotCents && opts.acceptedSnapshotCents > 0) return opts.acceptedSnapshotCents;
  if (opts.latestProposalCents && opts.latestProposalCents > 0) return opts.latestProposalCents;
  // No proposal the customer has seen: fall back to the AIA doc's explicit
  // contract / SOV (its system-of-record once billing starts), else the bid
  // midpoint, else an in-progress proposal as a last resort.
  // Once an AIA app exists it IS the system of record — answer from the document
  // even when that answer is zero. Falling past it to a bid range or a draft
  // would put a number on a certificate that the certificate doesn't contain.
  if (opts.hasBillingApp) {
    return opts.originalContractCents > 0 ? opts.originalContractCents : opts.sovTotalCents;
  }
  if (opts.bidMidCents > 0) return opts.bidMidCents;
  return opts.pendingProposalCents ?? 0;
}

/** The proposal fields the contract ladder needs. */
export type ContractProposalRow = {
  total_cents: number | string;
  status: string;
  revision_number: number;
};

/**
 * Which proposal totals may stand in as the contract — the ONE rule, shared by
 * the batch path (`listProjects`) and the single-opp path
 * (`contractLadderInputs`).
 *
 * It lived in both places, copied. That is the same defect twice over: a
 * divergence between them shows up as one job reporting two different contract
 * values on two screens, which is precisely what the ladder exists to prevent.
 *
 * The split is SEEN vs UNSEEN. `latestProposalCents` covers proposals the
 * customer has actually received or decided on (sent / won / lost / expired /
 * superseded). The pre-send trio (draft, pending approval, approved) is returned
 * separately as `pendingProposalCents`, for the bottom rung only.
 *
 * That split is the whole fix: an estimator opening a revision and typing its
 * first line must not move a number printed on a document the customer signed.
 * `superseded` stays eligible — superseding is just how a revision bump retires
 * the previous one, and that total was really sent to a real GC.
 */
const PRE_SEND_PROPOSAL_STATUSES = new Set(["draft", "pending_approval", "approved"]);

export function contractProposalCents(rows: ContractProposalRow[]): {
  acceptedProposalCents: number;
  latestProposalCents: number;
  pendingProposalCents: number;
} {
  let acceptedProposalCents = 0;
  let latestProposalCents = 0;
  let latestRev = -1;
  let pendingProposalCents = 0;
  let pendingRev = -1;
  for (const r of rows) {
    const cents = Number(r.total_cents) || 0;
    // If somehow >1 won proposal, keep the largest (defensive; should be one).
    if (r.status === "won") acceptedProposalCents = Math.max(acceptedProposalCents, cents);

    if (PRE_SEND_PROPOSAL_STATUSES.has(r.status)) {
      if (r.revision_number > pendingRev) {
        pendingRev = r.revision_number;
        pendingProposalCents = cents;
      }
      continue;
    }
    if (r.revision_number > latestRev) {
      latestRev = r.revision_number;
      latestProposalCents = cents;
    }
  }
  return { acceptedProposalCents, latestProposalCents, pendingProposalCents };
}

// ── When an AIA application falls due ────────────────────────────────────────

/**
 * How long after its period closes an application can be entered before we stop
 * believing `frozen_at` is when it was really issued.
 *
 * A certificate raised in the ordinary course is frozen within days of the
 * period ending. A month is generous for that, and far short of the gap a
 * back-entry leaves.
 */
export const AIA_BACKDATED_AFTER_DAYS = 30;

/**
 * The issue instant of an application, from whichever field recorded it.
 *
 * `frozen_at` is stamped when the certificate is issued and is usually the
 * truth. Older applications only carry `period_to`, a bare DATE, anchored at
 * 16:00Z — noon ET — so the day it lands on can't be flipped by a timezone.
 * Null when neither is recorded: unknown, never "today".
 *
 * 🔴 EXCEPT WHEN IT WAS BACK-ENTERED, which is most of this book.
 *
 * Katie, 2026-10-15: *"AR aging dates back-entered AIA from when it was
 * entered, so things look less overdue than they are."* Measured the same day:
 * 25 of 41 issued applications were frozen more than thirty days after their
 * period closed, the worst by 251 days — because Tomco's AIA history was typed
 * into the platform in September and October, long after the work was billed.
 *
 * Aging from `frozen_at` therefore reported NOTHING overdue: 37 applications
 * current, zero in every bucket. Aged from the period they actually bill, it is
 * 12 current and 29 late, nine of them past ninety days. A collections report
 * that says everyone has paid on time, about a book where nine certificates are
 * a quarter overdue, is worse than no report.
 *
 * So a `frozen_at` more than `AIA_BACKDATED_AFTER_DAYS` after `period_to` is
 * treated as a data-entry date rather than an issue date, and the period wins.
 * A normally-issued certificate is untouched — the gap is days, not a month.
 */
export function aiaIssuedAtFrom(
  frozenAt: string | null | undefined,
  periodTo: string | null | undefined
): string | null {
  const periodInstant = periodTo ? `${periodTo}T16:00:00Z` : null;
  if (!frozenAt) return periodInstant;
  if (!periodInstant) return frozenAt;
  const lagMs = new Date(frozenAt).getTime() - new Date(periodInstant).getTime();
  if (!Number.isFinite(lagMs)) return frozenAt;
  return lagMs > AIA_BACKDATED_AFTER_DAYS * 86_400_000 ? periodInstant : frozenAt;
}

/**
 * When the money on that application is payable — issue instant plus the
 * standard terms.
 *
 * ONE definition. This ladder was written out three times — the AR-aging
 * report, the receivables chase list, and the dashboard's project rows — which
 * is three chances for a job to be late on one screen and current on another.
 * `dueDays` is passed in rather than imported so this module stays client-safe.
 */
export function aiaDueAtFrom(
  frozenAt: string | null | undefined,
  periodTo: string | null | undefined,
  dueDays: number
): string | null {
  const issued = aiaIssuedAtFrom(frozenAt, periodTo);
  if (!issued) return null;
  const ms = new Date(issued).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms + dueDays * 86_400_000).toISOString();
}

/**
 * Collected on an AIA job, once some payments are recorded and some aren't.
 *
 * G702 line 6 is CUMULATIVE — it carries every prior period — so a recorded
 * payment and a legacy "paid" flag are not two numbers you can add naively,
 * and they are not two numbers where one simply replaces the other either.
 *
 * The first version of this replaced: any recorded payment on the job dropped
 * the inference entirely. On AIREF Building #1, where Application 2 was marked
 * paid before payments existed, recording $35,000 against Application 3 made
 * the $66,833.31 already collected VANISH — collected went DOWN when money
 * came in. It was caught by running it against the live job, not by reading it.
 *
 * The split is by application number:
 *   baseline — line 6 of the latest PAID application carrying no recorded
 *              payments. That single figure already contains everything
 *              collected up to and including it.
 *   plus     — payments recorded on applications AFTER that one.
 *
 * With nothing recorded, callers keep the old inference untouched, so no
 * existing job restates itself the day payments ship.
 */
export function aiaCollectedWithPayments(input: {
  /** Line 6 of the latest paid application that has no recorded payments. */
  baselineCents: number;
  /** Payments recorded against applications after the baseline one. */
  recordedAfterBaselineCents: number;
}): number {
  return (
    Math.max(0, Math.round(input.baselineCents)) +
    Math.max(0, Math.round(input.recordedAfterBaselineCents))
  );
}
