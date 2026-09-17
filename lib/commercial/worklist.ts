/**
 * The worklist — what actually needs doing, as rows you can act on.
 *
 * Karan: the Overview shows figures, not what needs doing, and "these KPIs are
 * just the same ones over and over."
 *
 * What was there: four cards reading "3 Overdue proposals", "2 Cold RFPs". A
 * count is not a task. It tells you a number and then asks you to go and find
 * out which ones, which is the work — so the strip got read as a status light
 * and nothing moved. It was also sales-only: none of the money Mary chases and
 * none of the delivery work appeared on the page the owner opens each morning.
 *
 * What this is instead: every open thing, named, with the job, what to do about
 * it, what it costs to leave, and a link to the surface that does it.
 *
 * TWO RULES, both learned from the strip this replaces:
 *
 *  1. A row must name its subject. "Chase Alta Construction — invoice 1043" is
 *     workable; "3 overdue invoices" sends you looking.
 *
 *  2. The order is money at risk, then how late. Not category. A $180k invoice
 *     sixty days out and a missing work order are not the same job, and a list
 *     that sorts them by which rule produced them buries the first.
 *
 * Pure — every input is already loaded by the page — so the ranking is testable
 * without a database, and adding a source costs one function, not a query.
 */

export type WorkGroup = "money" | "bids" | "delivery";

export type WorkItem = {
  key: string;
  /** Imperative, and specific: what a person would write on a sticky note. */
  action: string;
  /** The job or GC it concerns — shown as the row's subject line. */
  subject: string;
  /** What it costs to leave it. A row with no consequence gets ignored. */
  why: string;
  /** Where the doing happens. Never a list the person has to search. */
  href: string;
  group: WorkGroup;
  tone: "rose" | "amber" | "navy" | "emerald";
  /** Money at stake, when there is any. Drives the ordering. */
  cents?: number;
  /** How far past due, in whole days. */
  daysLate?: number;
};

/** Everything the page has already loaded, in the shape this needs. */
export type WorklistInput = {
  /** Invoices with money still out. Grouped per GC before they become rows. */
  overdueInvoices: {
    id: string;
    number: string | null;
    accountId: string | null;
    accountName: string;
    balanceCents: number;
    daysLate: number;
  }[];
  /** Won work that is finished enough to bill and has not been. */
  unbilled: { oppId: string; name: string; cents: number }[];
  /** Bids whose due date has passed. */
  overdueProposals: { oppId: string; name: string; daysLate: number; cents: number }[];
  /** Bid requests sitting untouched. */
  coldRfps: { oppId: string; name: string; daysWaiting: number }[];
  /** Check-ins due today or earlier. */
  followUps: { oppId: string; name: string; daysLate: number }[];
  /** Won jobs with no debrief filed. Only when the viewer can open Win/Loss. */
  awaitingDebrief: { oppId: string; name: string }[];
  /** Things missing on a job that block something downstream. */
  jobGaps: { oppId: string; name: string; title: string; consequence: string; href: string }[];
};

const oppHref = (id: string, tab?: string) =>
  tab ? `/commercial/opportunities/${id}?tab=${tab}` : `/commercial/opportunities/${id}`;

/** A day count in words, so a row reads as a sentence. */
function late(days: number): string {
  if (days <= 0) return "due today";
  if (days === 1) return "1 day late";
  return `${days} days late`;
}

/**
 * Rank.
 *
 * Money first, because leaving money is the only item on this list that costs
 * something every day it stays. Lateness breaks ties, and the small constant
 * for a row with no money at all keeps "no work order on a won job" above
 * nothing but below a real invoice.
 *
 * Deliberately NOT a weighted formula with tuned coefficients — nobody could
 * explain why one row sat above another, and a ranking you can't explain is one
 * people stop trusting the moment it surprises them.
 */
function score(i: WorkItem): number {
  const money = i.cents ?? 0;
  const days = i.daysLate ?? 0;
  // Cents dominate; days act as the tiebreak, worth up to a notional $1k.
  return money * 1000 + Math.min(days, 365) * 1000;
}

export function buildWorklist(input: WorklistInput): WorkItem[] {
  const items: WorkItem[] = [];

  // ONE ROW PER GC, not per invoice.
  //
  // The first build of this listed each overdue invoice, and the top eight came
  // back as eight rows of "Chase invoice SF-002878xx — LMJ Management": the
  // same complaint as the counts it replaced, in a new shape. Money-first
  // ranking means the biggest debtor takes every slot, and nobody chases an
  // invoice anyway — they ring a GC about everything at once.
  const byGc = new Map<string, { name: string; accountId: string | null; cents: number; count: number; oldest: number; invoiceId: string }>();
  for (const inv of input.overdueInvoices) {
    const key = inv.accountId ?? inv.accountName;
    const e = byGc.get(key) ?? { name: inv.accountName, accountId: inv.accountId, cents: 0, count: 0, oldest: 0, invoiceId: inv.id };
    e.cents += inv.balanceCents;
    e.count += 1;
    e.oldest = Math.max(e.oldest, inv.daysLate);
    byGc.set(key, e);
  }
  for (const [key, g] of byGc) {
    items.push({
      key: `gc:${key}`,
      subject: g.name,
      action: "Chase what they owe",
      why:
        g.count === 1
          ? `one invoice, ${late(g.oldest)}`
          : `${g.count} invoices, oldest ${late(g.oldest)}`,
      // A single invoice opens that invoice; several open the filtered
      // receivables list, which is the surface for working a GC down to zero.
      href:
        g.count === 1
          ? `/commercial/invoices/${g.invoiceId}`
          : g.accountId
            ? `/commercial/accounting?view=receivables&gc=${g.accountId}&overdue=1`
            : "/commercial/accounting?view=receivables&overdue=1",
      group: "money",
      tone: g.oldest >= 60 ? "rose" : "amber",
      cents: g.cents,
      daysLate: g.oldest,
    });
  }

  for (const u of input.unbilled) {
    items.push({
      key: `bill:${u.oppId}`,
      subject: u.name,
      action: "Bill the work that is done",
      why: "finished and not invoiced — nothing can be collected until it is",
      href: oppHref(u.oppId, "invoices"),
      group: "money",
      tone: "amber",
      cents: u.cents,
    });
  }

  for (const p of input.overdueProposals) {
    items.push({
      key: `prop:${p.oppId}`,
      subject: p.name,
      action: "Get the bid out",
      why: `${late(p.daysLate)} — the GC is waiting and may already have priced it elsewhere`,
      href: oppHref(p.oppId, "proposals"),
      group: "bids",
      tone: "rose",
      cents: p.cents,
      daysLate: p.daysLate,
    });
  }

  for (const c of input.coldRfps) {
    items.push({
      key: `rfp:${c.oppId}`,
      subject: c.name,
      action: "Answer the bid request",
      why: `${c.daysWaiting} days since it came in with nothing back`,
      href: oppHref(c.oppId),
      group: "bids",
      tone: "amber",
      daysLate: c.daysWaiting,
    });
  }

  for (const f of input.followUps) {
    items.push({
      key: `fu:${f.oppId}`,
      subject: f.name,
      action: "Follow up",
      why: f.daysLate > 0 ? `check-in ${late(f.daysLate)}` : "check-in due today",
      href: oppHref(f.oppId),
      group: "bids",
      tone: "navy",
      daysLate: f.daysLate,
    });
  }

  for (const d of input.awaitingDebrief) {
    items.push({
      key: `deb:${d.oppId}`,
      subject: d.name,
      action: "File the debrief",
      why: "won with no reason recorded — the win/loss report is only as good as these",
      href: "/commercial/reports/win-loss",
      group: "bids",
      tone: "emerald",
    });
  }

  for (const g of input.jobGaps) {
    items.push({
      key: `gap:${g.oppId}:${g.title}`,
      subject: g.name,
      action: g.title,
      why: g.consequence,
      href: g.href,
      group: "delivery",
      tone: "navy",
    });
  }

  return items.sort((a, b) => score(b) - score(a) || a.subject.localeCompare(b.subject));
}

/**
 * The rows actually shown, in ranked order, with every group represented.
 *
 * Straight ranking put eight money rows on screen and hid the overdue bid
 * entirely — correct by the sort, useless as a morning read, because the one
 * thing the owner could have done nothing about by lunchtime was the one thing
 * he couldn't see. So: take the ranked top, then if a group has work and none
 * of it made the cut, promote its best row into the last slot. It costs the
 * lowest-ranked money row, which is by definition the least urgent one.
 *
 * The order of what survives is still the score — this only guarantees
 * presence, never position.
 */
export function visibleWorklist(items: WorkItem[], shown: number): WorkItem[] {
  if (items.length <= shown) return items;
  const picked = items.slice(0, shown);
  const groups: WorkGroup[] = ["money", "bids", "delivery"];
  for (const g of groups) {
    if (picked.some((i) => i.group === g)) continue;
    const best = items.find((i) => i.group === g);
    if (!best) continue;
    // Drop the last row of whichever group is over-represented.
    const counts = new Map<WorkGroup, number>();
    for (const i of picked) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
    let dropIndex = -1;
    for (let n = picked.length - 1; n >= 0; n--) {
      if ((counts.get(picked[n].group) ?? 0) > 1) {
        dropIndex = n;
        break;
      }
    }
    if (dropIndex === -1) continue;
    picked.splice(dropIndex, 1);
    picked.push(best);
  }
  return picked.sort((a, b) => items.indexOf(a) - items.indexOf(b));
}

/** The headline above the list: how much is at risk, across how many things. */
export function worklistTotals(items: WorkItem[]): { count: number; atRiskCents: number } {
  return {
    count: items.length,
    // Only money that is genuinely at risk — a follow-up carries the deal's
    // value, which is not money anybody is owed, and adding it would inflate
    // the headline into something nobody could reconcile against Accounting.
    atRiskCents: items.filter((i) => i.group === "money").reduce((n, i) => n + (i.cents ?? 0), 0),
  };
}
