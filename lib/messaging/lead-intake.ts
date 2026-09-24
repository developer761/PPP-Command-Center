/**
 * What to do with a lead once it arrives.
 *
 * Pure. Salesforce field mapping is still unconfirmed with Katie, so this takes
 * an already-extracted lead rather than a raw payload — the extraction can
 * change without any of these decisions moving.
 *
 * The decision this makes is narrow but consequential: route it, send it to
 * triage, or ignore it. Every path that is not "route" has to name what was
 * wrong, because a lead that quietly disappears is the failure PPP already
 * lives with — Hatch drops leads into a 15-minute window and nobody can tell
 * a slow day from a broken integration.
 */
import { toE164, type E164 } from "./phone";
import { routeLead, type RoutableWorkspace } from "./routing";

export type IncomingLead = {
  sfRecordId: string;
  phone?: string | null;
  email?: string | null;
  fullName?: string | null;
  leadSource?: string | null;
  state?: string | null;
  locality?: string | null;
  /** The lead's PostalCode. Present on 99.5% of real leads, and the signal
   *  routing actually trusts — see territory.ts. */
  postalCode?: string | null;
  /** The street line on the lead. Needed to assemble a full address, which
   *  A11 defines as street plus zip. */
  street?: string | null;
  /** Street, city, state and zip as one line, or null when street or zip is
   *  missing. Half an address is not an address we can read back. */
  address?: string | null;
  /**
   * What the lead said they wanted done, in their own words.
   *
   * NOT YET SOURCED. PPP plainly has such a field — the placeholder Kate
   * quotes, "Customer did not provide additional comments. Please contact the
   * customer to discuss the details of this project.", is a value sitting in
   * one — but Description is standard and PPP may use a custom field, and
   * guessing a Salesforce field name is how the last mistake happened. The
   * plumbing is here so that naming it is a one-line change in lead-map.ts.
   */
  inquiryScope?: string | null;
  sfCreatedAt?: string | null;
};

export type IntakeDecision =
  | { action: "route"; workspaceId: string; workspaceName: string; phone: E164; why: string }
  | { action: "triage"; reason: TriageReason; detail: string }
  | { action: "ignore"; reason: string };

export type TriageReason =
  | "no_contactable_phone"
  | "no_matching_workspace"
  | "region_not_live"
  | "workspace_has_no_number"
  /** Kate A2: outside the service area, Out of Area, or an inactive
   *  territory. A person checks with the estimator; the bot never promises
   *  coverage it cannot deliver. */
  | "not_serviced"
  /** A state PPP covers, split across several teams, and nothing said which.
   *  Ten seconds of a person, rather than a guess that texts somebody two
   *  counties away from a local number. */
  | "region_unclear";

export type IntakeContext = {
  workspaces: RoutableWorkspace[];
  /** Numbers already suppressed. Checked here as well as in the gate — not
   *  because the gate is unreliable, but because opening a conversation with
   *  somebody who opted out and only discovering it at send time leaves a
   *  thread in the inbox that should never have existed. */
  isSuppressed?: (phone: E164) => boolean;
  /**
   * Resolve a ZIP against PPP's own Zip_Code__c map — see territory.ts.
   *
   * Injected rather than looked up here so this stays pure and the caller can
   * fetch all 2,194 rows once per batch instead of once per lead. Omitted, and
   * routing falls back to the city and state, which is what it did before and
   * is markedly worse.
   */
  territoryFor?: (postalCode: string | null) => import("./territory").TerritoryVerdict | null;
};

export function decideIntake(lead: IncomingLead, ctx: IntakeContext): IntakeDecision {
  const phone = toE164(lead.phone ?? null);

  // A lead with no usable phone is not a failure of routing, and calling it
  // one would send somebody to look at the wrong thing. Texting a landline or
  // a mistyped number burns the first touch, so toE164 refusing is the right
  // outcome — but it has to be visible.
  if (!phone) {
    return {
      action: "triage",
      reason: "no_contactable_phone",
      detail: lead.phone
        ? `"${lead.phone}" is not a number we can text`
        : "no phone on the record",
    };
  }

  if (ctx.isSuppressed?.(phone)) {
    return { action: "ignore", reason: "this number has opted out" };
  }

  const routed = routeLead(
    {
      source: lead.leadSource ?? null,
      state: lead.state ?? null,
      locality: lead.locality ?? null,
      // Resolved by the caller against PPP own zip map. The primary signal.
      territory: ctx.territoryFor?.(lead.postalCode ?? null) ?? null,
    },
    ctx.workspaces
  );

  if (routed.ok) {
    return {
      action: "route",
      workspaceId: routed.workspaceId,
      workspaceName: routed.workspaceName,
      phone,
      why: routed.why,
    };
  }

  // Routing already distinguishes these, and they need different people: a
  // region not switched on is a rollout decision, a workspace without a number
  // is a data gap, and no match at all is a routing rule that needs writing.
  const reason: TriageReason =
    routed.reason === "matched_inactive" ? "region_not_live"
    : routed.reason === "matched_no_number" ? "workspace_has_no_number"
    : routed.reason === "not_serviced" ? "not_serviced"
    : routed.reason === "ambiguous_region" ? "region_unclear"
    : "no_matching_workspace";

  return { action: "triage", reason, detail: routed.detail };
}

/**
 * Speed to lead, in seconds.
 *
 * The number PPP is actually buying. Hatch notices a lead up to 15 minutes
 * after Salesforce created it; the target here is a message inside one minute.
 * Returns null rather than 0 when either end is missing, because a missing
 * measurement and an instant reply must not look the same on a dashboard.
 */
export function speedToLeadSeconds(
  sfCreatedAt: string | Date | null | undefined,
  firstMessageAt: string | Date | null | undefined
): number | null {
  if (!sfCreatedAt || !firstMessageAt) return null;
  const a = new Date(sfCreatedAt).getTime();
  const b = new Date(firstMessageAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  // Clock skew between Salesforce and us can make this negative. Report 0
  // rather than a negative age, which would read as a message sent before the
  // lead existed.
  return Math.max(0, Math.round((b - a) / 1000));
}
