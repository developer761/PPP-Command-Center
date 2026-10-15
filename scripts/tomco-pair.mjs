/**
 * Clear the Tomco write-back pairing queue from the terminal.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs \
 *        scripts/tomco-pair.mjs                 shows the plan, writes nothing
 *   …same… scripts/tomco-pair.mjs --apply       does it
 *
 * The screen at /dashboard/settings/writeback/tomco does the same thing with
 * buttons. This exists because the decision is sometimes easier to make from a
 * terminal where the evidence can be laid out in full, and because it does not
 * need a dev server.
 *
 * It writes to PRODUCTION Salesforce — one field, `UniqueExternalId__c`, on an
 * opportunity a person has chosen. That field is what makes the link permanent
 * and stops the nightly write-back ever creating a second copy of the sale.
 *
 * Every decision below is typed out by hand on purpose. An "auto-pair the top
 * match" flag would defeat the entire point of the queue.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

/**
 * The decisions. Each one is a claim about the real world, with the evidence
 * that supports it, so a reader can disagree before anything is written.
 */
const DECISIONS = [
  {
    dealTitle: /^Cummins/i,
    choose: "006Wj00000qbgLhIAI",
    expectName: "Cummins -Interior",
    because:
      "Salesforce holds it at $5,150 and the Command Center sold it at $5,150 — the same cent, the same GC, six days apart. Mary entered the estimate on 09-30; the deal closed here on 10-13.",
  },
  {
    dealTitle: /PCCI.*Eastport|Eastport.*Facade/i,
    choose: "006Wj00000nNN1JIAW",
    expectName: "Facade Renovation-Eastport",
    because:
      "Same GC, same job — 'Eastport Facade Renovation' against 'Facade Renovation-Eastport'. The amount differs ($9,350 estimated, $8,900 sold) because it was renegotiated after the estimate went out, which is why no amount-matcher would find it.",
  },
  {
    dealTitle: /^Flagstar/i,
    choose: null, // a new sale
    because:
      "Nothing in Salesforce matches. Searched the whole Tomco book for 'Flagstar' and for the Hempstead Turnpike address: no hit. It is only in the queue because it sits on PCCI's account, and PCCI has an unrelated job open.",
  },
];

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { listUnpairedSoldDeals, listOpenSalesforceCandidates, listResolvedDeals, rankCandidates, pairDealToSalesforce, markDealAsNew, recordPairingDecision } =
  await import("@/lib/salesforce/tomco-pairing");

const money = (c) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

const [deals, candidates, resolved] = await Promise.all([
  listUnpairedSoldDeals(),
  listOpenSalesforceCandidates(),
  listResolvedDeals(),
]);

console.log(`\n══ TOMCO PAIRING · ${APPLY ? "APPLYING — writes to production Salesforce" : "DRY RUN"} ══`);
console.log(`   ${deals.length} unlinked sold deal(s) · ${candidates.length} open Salesforce estimates · ${resolved.size} already decided\n`);

const planned = [];
for (const d of DECISIONS) {
  const deal = deals.find((x) => d.dealTitle.test(x.title));
  if (!deal) {
    console.log(`   ⏭  nothing matching ${d.dealTitle} is waiting — already decided, or gone`);
    continue;
  }
  if (resolved.has(deal.id)) {
    console.log(`   ⏭  ${deal.title.slice(0, 44)} — already decided`);
    continue;
  }
  const ranked = rankCandidates(deal, candidates);

  if (d.choose) {
    const target = ranked.find((c) => c.sfId === d.choose);
    if (!target) {
      console.log(`\n   🔴 ${deal.title.slice(0, 44)} — ${d.choose} is not among the open estimates. REFUSING.`);
      continue;
    }
    /*
     * The chosen record must also be the one the ranker put first. If a human
     * decision and the evidence disagree, that is worth stopping for: either
     * the reasoning above is wrong, or the data moved since it was written.
     */
    const topIsChoice = ranked[0]?.sfId === d.choose;
    console.log(`\n   ${topIsChoice ? "🔗" : "⚠️ "} ${deal.title.slice(0, 50)}  ${money(deal.contractCents)}`);
    console.log(`        → ${target.name}  ${money(target.subtotalCents)}  (${target.sfId})`);
    console.log(`        evidence: ${target.reasons.join(" · ")}   [score ${target.score}]`);
    console.log(`        because:  ${d.because}`);
    if (!topIsChoice) {
      console.log(`        🔴 NOT the top-ranked candidate (that is "${ranked[0]?.name}"). REFUSING — check this by hand.`);
      continue;
    }
    planned.push({ deal, target, ranked });
  } else {
    console.log(`\n   ✳️  ${deal.title.slice(0, 50)}  ${money(deal.contractCents)}  → NEW SALE`);
    console.log(`        best candidate was "${ranked[0]?.name}" at ${money(ranked[0]?.subtotalCents)} — ${ranked[0]?.reasons.join(" · ")}`);
    console.log(`        because:  ${d.because}`);
    planned.push({ deal, target: null, ranked });
  }
}

if (planned.length === 0) {
  console.log(`\nNothing to do.\n`);
  process.exit(0);
}
if (!APPLY) {
  console.log(`\n${planned.length} decision(s) ready. Re-run with --apply to write them.\n`);
  process.exit(0);
}

console.log(`\n── writing ──`);
let failed = 0;
for (const { deal, target, ranked } of planned) {
  const seen = ranked.slice(0, 8).map((c) => ({ sfId: c.sfId, name: c.name, score: c.score }));
  if (target) {
    const res = await pairDealToSalesforce({ dealId: deal.id, sfOpportunityId: target.sfId, actorUserId: null });
    if (!res.ok) { failed++; console.log(`   🔴 ${deal.title.slice(0, 40)}: ${res.error}`); continue; }
    await recordPairingDecision({ dealId: deal.id, sfOpportunityId: target.sfId, actorUserId: null, candidatesSeen: seen });
    console.log(`   ✅ ${deal.title.slice(0, 40)} → ${target.sfId}`);
  } else {
    const res = await markDealAsNew({ dealId: deal.id, actorUserId: null, candidatesSeen: seen });
    if (!res.ok) { failed++; console.log(`   🔴 ${deal.title.slice(0, 40)}: ${res.error}`); continue; }
    console.log(`   ✅ ${deal.title.slice(0, 40)} → marked a new sale`);
  }
}
console.log(
  failed === 0
    ? `\n✅ ${planned.length} decision(s) recorded. The write-back will update the linked records and add the new ones.\n`
    : `\n${failed} of ${planned.length} failed.\n`,
);
