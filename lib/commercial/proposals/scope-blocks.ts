/**
 * Free-text scope blocks: which rows are they, what tax rides on one, and does
 * the page still owe the reader a grand total.
 *
 * Stephanie 2026-10-05, attaching two proposals she had just typed by hand in
 * Word: "the drop down inclusion option is excellent for Kim the estimator,
 * [but] it is cumbersome and it doesn't really work when I am asked to do
 * proposals because most of the time there isn't a formal take off or plans
 * etc. It is just Brendan typing up an email and sending to me to put into
 * proposal format."
 *
 * These three decisions live here rather than inside the renderer because the
 * renderer cannot be asserted on: react-pdf compresses its content streams, so
 * a test that greps the PDF bytes for "TOTAL" passes whether or not the word
 * was ever drawn. That exact trap has already produced a green test over a
 * broken document in this codebase. Pure functions can be tested for real; the
 * renderer is then tested for what it alone can show, which is layout.
 */
import type { CommercialProposalLineItem } from "./db";

/** Who the document is for. Mirrors the renderer's own mode. */
export type ProposalRenderMode = "customer" | "internal" | (string & {});

/**
 * Split the line items into the narrative blocks and everything else.
 *
 * Done once, on the way into the renderer, for the same reason internal rows
 * are: a print path added later cannot forget the rule and print a block twice
 * — once as a headed section and once as a row in the Inclusions list.
 *
 * `is_scope_block` is optional on the type because the column arrives in
 * migration 20261005150000 and this repo has no migration runner, so an
 * un-migrated database must still render: every row simply reads as an
 * ordinary inclusion, which is what it was.
 */
export function splitScopeBlocks(
  lineItems: CommercialProposalLineItem[],
  mode: ProposalRenderMode,
): { scopeBlocks: CommercialProposalLineItem[]; inclusions: CommercialProposalLineItem[] } {
  const isBlock = (i: CommercialProposalLineItem) =>
    i.is_scope_block === true && !i.is_alternate && !i.is_labor;
  const blocks = lineItems.filter(isBlock);
  return {
    // Internal rows never reach the customer copy, blocks included.
    scopeBlocks: mode === "customer" ? blocks.filter((i) => i.is_internal !== true) : blocks,
    inclusions: lineItems.filter((i) => !i.is_alternate && !i.is_labor && !isBlock(i)),
  };
}

/**
 * The tax on one block, at the proposal's OWN resolved rate.
 *
 * Deliberately the same arithmetic and the same rate as `proposalTaxLine`,
 * taken from the tax line the page already resolved, so a block's tax cannot
 * disagree with the tax at the foot of the same page. `rateThou` is
 * thousandths of a percent (8.625% = 8625), as in commercial_tax_jurisdictions.
 *
 * Null rate means no tax line prints at all — exempt job, capital improvement,
 * or a ZIP matching no jurisdiction. Null is not zero: a block printing
 * "NYS Sales Tax: $0.00" on an exempt job invites the question of why it is
 * there.
 */
export function scopeBlockTaxCents(priceCents: number, rateThou: number | null): number | null {
  if (rateThou == null) return null;
  return Math.round((priceCents * rateThou) / 100_000);
}

/**
 * Does the page still owe the reader a grand total?
 *
 * Only when there is priced work OUTSIDE the blocks. Her Inspection Room
 * sample is three priced blocks — Inspection Room, Exterior Doors, 100 13th
 * Ave — each with its own Price / NYS Sales Tax / TOTAL and nothing underneath:
 * the three totals ARE the proposal, and a fourth figure beneath them is one
 * the GC has to work out the meaning of. Her Glenwood sample is one scope and
 * one total, which is what a proposal with no blocks has always printed.
 *
 * Decided on the MONEY rather than on a flag, so it cannot be set wrong: if
 * anything outside the blocks carries a price, the figures no longer add up on
 * their own and the total has to print. A hand-set final price prints for the
 * same reason — it is a number no block explains. The internal copy always
 * prints it; that reader is checking the arithmetic.
 */
export function shouldPrintGrandTotal(args: {
  mode: ProposalRenderMode;
  scopeBlocks: CommercialProposalLineItem[];
  /** Σ of the blocks' line totals. */
  scopeBlockSumCents: number;
  /** `proposal.total_cents` — every non-alternate line, blocks included. */
  totalCents: number;
  /** A final price was set by hand, so the total is not the sum of the lines. */
  overrideActive: boolean;
}): boolean {
  if (args.mode === "internal") return true;
  if (args.scopeBlocks.length === 0) return true;
  if (args.overrideActive) return true;
  // A cent of slack: the blocks' own rounding must not resurrect the total.
  return Math.abs(args.totalCents - args.scopeBlockSumCents) > 1;
}

/**
 * A block's body, as the lines it prints — TEXT ONLY, no bullet character.
 *
 * The bullet is drawn, not typed. Every other list on this document renders a
 * 5pt filled circle as a `View` beside the text, with a comment on the style
 * saying why: "Kept as View not glyph so it works across any font." The PDF is
 * set in Times, which has no ● glyph.
 *
 * My first version prefixed "● " as text and it came out as "Ï" on the
 * proposal Stephanie generated — which is what she reported as "can the option
 * to bullet within both?". So this strips any bullet she typed or pasted and
 * returns the words; the renderer puts a real dot beside each one.
 *
 * Her text comes out of an email, so blank lines go too.
 */
export function scopeBlockLines(description: string | null | undefined): string[] {
  return String(description ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[●•◦▪·*•●▪-]+\s*/, "").trim())
    .filter(Boolean);
}
