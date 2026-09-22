/**
 * Which conversation a workspace is having: a new lead, or a quote already out.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────
 *
 * Migration 196 built the nurture track, seeded its config, and said plainly
 * which workspaces carry it:
 *
 *   "AM - NY, AM - NJ and AM - SoFlo are the account-management surfaces and
 *    carry nurture, while the Leads and Meta workspaces carry new leads."
 *
 * Then nothing ever set it. sms_conversations.track defaulted to 'new_lead'
 * on every row, draftReply never read it, and agentConfigFor was called with
 * no track at all — so the nurture config and Kate's nurture rules resolved
 * for nobody. Every AM conversation ran the NEW LEAD prompt.
 *
 * That prompt asks for the project details, the address, the contact details
 * and the availability. The customer it was asking has already had an
 * estimator at their house and has the quote in writing. Migration 196 names
 * this exactly: "the single most obvious way to prove nobody is reading."
 *
 * Only the simulator ever passed a track, so it was right in the sandbox and
 * wrong in production — the divergence this codebase keeps rediscovering.
 *
 * Pure.
 */
import type { Track } from "./agent-output";

/**
 * Account-management workspaces, by the prefix PPP names them with.
 *
 * The same prefix routing.ts already uses to keep new leads OUT of these
 * workspaces, which is the other half of the same fact: a lead never enters an
 * AM workspace, and a conversation that is in one is therefore never a new
 * lead. Matching on the name is not elegant, but it is the actual convention
 * and inventing a column somebody has to remember to set would be worse.
 */
const ACCOUNT_MANAGEMENT = /^AM\s*-\s*/i;

export function isAccountManagement(workspaceName: string | null | undefined): boolean {
  return ACCOUNT_MANAGEMENT.test((workspaceName ?? "").trim());
}

/** The track a conversation in this workspace belongs to. */
export function trackForWorkspace(workspaceName: string | null | undefined): Track {
  return isAccountManagement(workspaceName) ? "nurture" : "new_lead";
}

/** Read a stored track, defaulting safely. */
export function asTrack(v: string | null | undefined): Track {
  return v === "nurture" ? "nurture" : "new_lead";
}
