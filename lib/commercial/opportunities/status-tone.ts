/**
 * The ONE status → colour map for a deal.
 *
 * There were five of these. Two were dead v1 maps keyed on statuses that no
 * longer exist (`won`, `lost`, `inquiry`, `negotiating`, `on_hold`…), whose
 * intersection with the live 8-status enum was a single value — so on the deal
 * header and every pipeline row, seven of eight statuses fell through to grey.
 * A won deal and a lost deal rendered as the identical grey pill reading
 * "Closed", one inch above a status bar that correctly said Won or Lost.
 *
 * The other three disagreed with each other: the same won job was navy on
 * Account 360, emerald in the pipeline sheet, and grey on its own page.
 *
 * `UI_RESTRUCTURE_NOTE.md` §2 already specified "status color =
 * statusPillTone(status, sub) (one helper)". This is that helper, lifted out of
 * the one page that had it right so the other four can stop guessing.
 *
 * Deliberately takes `string`, not the status union, so legacy rows and junk
 * resolve to a sane tone instead of throwing.
 */
export function statusPillTone(
  status: string | null | undefined,
  sub_status?: string | null
): { cls: string } {
  // Terminal (v2 + v1 legacy).
  // Won is NAVY, not emerald — Karan's call, and the won-not-started card on
  // the account page is navy. A green pill above that navy card read as two
  // different states for one deal.
  if (status === "pre_sale_closed" && sub_status === "won") return { cls: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
  if (status === "pre_sale_closed" && sub_status === "lost") return { cls: "bg-rose-50 text-rose-800 border-rose-200" };
  if (status === "won") return { cls: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
  if (status === "lost") return { cls: "bg-rose-50 text-rose-800 border-rose-200" };
  // 2026-07-28 colour audit: semantic palette only (cc-brand red is the action
  // colour, never a status). Active stage → ppp-blue, working/attention →
  // amber, done → emerald, lost → rose, early → charcoal. Labels distinguish
  // stages that share a tone.
  if (status === "pre_construction") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "in_progress") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "billing") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  // A finished job is navy too — same "won" family, further along.
  if (status === "post_sale_closed") return { cls: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
  if (status === "proposal" && sub_status === "follow_up") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  if (status === "proposal") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "estimating") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  // RFP is the entry stage since 2026-08-17; the whole qualifying lane reads
  // as RFP, so it takes the active-stage blue rather than the old grey.
  if (status === "qualifying") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  // v1.1 legacy fallbacks (shouldn't hit post-migration but defensive).
  if (status === "follow_up") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  if (status === "proposal_sent") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "proposal_pending_approval") return { cls: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
  if (status === "rfp") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  return { cls: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100" };
}
