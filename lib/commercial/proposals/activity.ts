import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * What has happened to this proposal, in order.
 *
 * Brendan 2026-09-23: "Add an activity section for the proposal… if Brendan
 * puts it to get approved, he adds a note when he requests changes etc, makes
 * changes as well etc."
 *
 * Everything needed was already being written — `commercial_audit_log` has
 * carried every proposal and line-item change since the platform was built —
 * it had simply never been read back on this screen. So this is a READER, not
 * a new history: no second source of truth to drift, and the record covers
 * changes made before the feature existed.
 *
 * Two traps, both already paid for once in this repo:
 *
 *  · the timestamp column is `at`, NOT `created_at`. Selecting the wrong name
 *    makes PostgREST reject the whole query and return nothing — a repair
 *    routine once "found zero" with 548 matching rows in the table.
 *  · line items are audited by their OWN row id, so a deleted line cannot be
 *    found by joining to the lines that still exist. The proposal_id is inside
 *    the logged row itself, which is what this filters on — otherwise the
 *    activity would quietly omit exactly the edits somebody is asking about.
 */

/** Status names as they read in a sentence. Deliberately not
 *  `proposalReadableStatus`, which is phrased for error messages ("a draft",
 *  "already sent") and reads wrong after "Moved to". */
const STATUS_LABEL: Record<string, string> = {
  draft: "draft",
  pending_approval: "awaiting approval",
  approved: "approved",
  sent: "sent to the customer",
  won: "won",
  lost: "lost",
  expired: "expired",
  superseded: "superseded by a newer revision",
};

export type ProposalActivityEvent = {
  at: string;
  /** Who did it — resolved to a name where we have one. */
  actor: string | null;
  /** One line, past tense, readable by somebody who was not there. */
  summary: string;
  /** The note an approver typed when sending it back, if this is that event. */
  note?: string | null;
  kind: "status" | "edit" | "created" | "line";
};

type LogRow = {
  row_id: string;
  action: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  user_id: string | null;
  at: string;
};

/** Fields whose change is worth a line in the feed. Everything else on a
 *  proposal row is bookkeeping (updated_at, updated_by) and would bury the
 *  events that matter. */
const INTERESTING: Record<string, string> = {
  total_cents: "the total",
  header_json: "the header",
  bid_notes: "the bid notes",
  intro_text_override: "the intro",
  exclusion_ids: "the exclusions",
  custom_exclusions: "the exclusions",
  alternate_notes: "the alternate notes",
  final_price_override_cents: "the final price override",
  pdf_show_line_prices: "the PDF options",
  estimator_snapshot_json: "the estimator sign-off",
};

export async function listProposalActivity(
  proposalId: string,
): Promise<ProposalActivityEvent[]> {
  const sb = commercialDb();

  const [proposalLog, lineLog] = await Promise.all([
    sb
      .from("commercial_audit_log")
      .select("row_id, action, before_json, after_json, user_id, at")
      .eq("table_name", "commercial_proposals")
      .eq("row_id", proposalId)
      .order("at", { ascending: false })
      .limit(200),
    sb
      .from("commercial_audit_log")
      .select("row_id, action, before_json, after_json, user_id, at")
      .eq("table_name", "commercial_proposal_line_items")
      // BOTH sides. A delete logs before_json only, so filtering on after_json
      // alone would have silently dropped every "Removed …" — the one event
      // somebody scrolling this feed is most likely looking for.
      .or(`after_json->>proposal_id.eq.${proposalId},before_json->>proposal_id.eq.${proposalId}`)
      .order("at", { ascending: false })
      .limit(200),
  ]);

  const rows = [
    ...((proposalLog.data ?? []) as LogRow[]).map((r) => ({ r, line: false })),
    ...((lineLog.data ?? []) as LogRow[]).map((r) => ({ r, line: true })),
  ];
  if (rows.length === 0) return [];

  // Resolve the actors in ONE query rather than per row.
  const userIds = [...new Set(rows.map(({ r }) => r.user_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await sb
      .from("profiles")
      .select("user_id, full_name, email")
      .in("user_id", userIds);
    for (const p of (profiles ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
      names.set(p.user_id, (p.full_name ?? "").trim() || (p.email ?? "").split("@")[0] || "Someone");
    }
  }

  const events: ProposalActivityEvent[] = [];

  for (const { r, line } of rows) {
    const actor = r.user_id ? names.get(r.user_id) ?? "Someone" : null;
    const before = r.before_json ?? {};
    const after = r.after_json ?? {};

    if (line) {
      const name =
        String(after.product_name ?? before.product_name ?? "").trim() ||
        String(after.description ?? before.description ?? "").trim().slice(0, 48) ||
        "a line";
      events.push({
        at: r.at,
        actor,
        kind: "line",
        summary:
          r.action === "insert"
            ? `Added “${name}”`
            : r.action === "delete"
              ? `Removed “${name}”`
              : `Edited “${name}”`,
      });
      continue;
    }

    if (r.action === "insert") {
      events.push({ at: r.at, actor, kind: "created", summary: "Created this proposal" });
      continue;
    }

    // A status move is the headline; say what it became in the words the rest
    // of the screen uses, not the raw enum.
    const fromStatus = before.status == null ? null : String(before.status);
    const toStatus = after.status == null ? null : String(after.status);
    if (fromStatus && toStatus && fromStatus !== toStatus) {
      const note =
        toStatus === "draft" && after.changes_requested_note
          ? String(after.changes_requested_note)
          : null;
      events.push({
        at: r.at,
        actor,
        kind: "status",
        note,
        summary:
          toStatus === "pending_approval"
            ? "Sent for approval"
            : toStatus === "approved"
              ? "Approved"
              : toStatus === "draft" && fromStatus === "pending_approval"
                ? "Sent back for changes"
                : toStatus === "draft" && fromStatus === "approved"
                  ? "Unlocked to edit — the approval was cleared"
                  : `Moved to ${STATUS_LABEL[toStatus] ?? toStatus}`,
      });
      continue;
    }

    // Not a status move: name what actually changed, so "edited" is answerable.
    const changed = Object.keys(INTERESTING).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (changed.length === 0) continue;
    const what = [...new Set(changed.map((k) => INTERESTING[k]))];
    events.push({
      at: r.at,
      actor,
      kind: "edit",
      summary: `Changed ${what.slice(0, 3).join(", ")}${what.length > 3 ? " and more" : ""}`,
    });
  }

  // Newest first, and the line-item and proposal streams interleaved properly.
  events.sort((a, b) => b.at.localeCompare(a.at));
  return events;
}
