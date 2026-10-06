"use server";

/**
 * What a reviewer CHANGED, which until now nothing could read.
 *
 * ── THE COLUMN THAT WAS WRITE-ONLY ──────────────────────────────────────
 *
 * Migration 198 states the intent in capitals: "THE EDIT IS THE POINT.
 * final_body is kept separately from body rather than overwriting it, because
 * the difference between what the agent wrote and what the human sent is the
 * most valuable training signal this system can produce. It is a good example
 * being authored as a by-product of somebody doing their job, which is the
 * only way a corpus ever gets filled."
 *
 * It was written by sendDraft and read by nothing — a repo-wide grep on
 * 2026-10-06 found one writer, one test, and no application reader. The same
 * for `reject_reason`, which the review screen asks for under the label "the
 * most useful thing you can leave". Both accumulate in columns no screen,
 * export, report or training path has ever looked at.
 *
 * So this is the reader. It does not decide anything or write anywhere: a
 * person reads an edit and chooses what it is worth, exactly as they do in the
 * repair console, which is the same act on an older conversation.
 */

import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";

export type DraftEdit = {
  id: string;
  conversationId: string;
  /** "rewritten" — they sent their own words. "rejected" — they binned it. */
  kind: "rewritten" | "rejected";
  /** What the bot proposed. */
  botWrote: string;
  /** What the person actually sent. Null on a rejection: nothing was sent. */
  humanSent: string | null;
  /** Why they binned it, when they said. */
  why: string | null;
  intent: string | null;
  confidence: number | null;
  at: string | null;
};

/**
 * Edits and rejections, newest first.
 *
 * Rewrites and rejections together on purpose: they are the two ways a person
 * says "not that", and reading only one of them gives half the picture. A
 * rejection with a reason is often the more pointed of the two, because
 * somebody bothered to type why.
 */
export async function draftEdits(limit = 50): Promise<DraftEdit[]> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data } = await sb.from("sms_drafts")
    .select("id, conversation_id, body, final_body, reject_reason, intent, confidence, state, reviewed_at, updated_at")
    // A sent draft only carries final_body when it actually differed —
    // sendDraft stores null otherwise, so an unchanged copy cannot bury the
    // corrections that matter.
    .or("final_body.not.is.null,and(state.eq.rejected)")
    .order("updated_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((d) => {
    const rejected = d.state === "rejected";
    return {
      id: d.id as string,
      conversationId: d.conversation_id as string,
      kind: rejected ? ("rejected" as const) : ("rewritten" as const),
      botWrote: (d.body as string) ?? "",
      humanSent: rejected ? null : ((d.final_body as string) ?? null),
      why: (d.reject_reason as string) ?? null,
      intent: (d.intent as string) ?? null,
      confidence: (d.confidence as number) ?? null,
      at: (d.reviewed_at as string) ?? (d.updated_at as string) ?? null,
    };
  });
}

/** How many there are, for the Training screen to say so without loading them. */
export async function draftEditCount(): Promise<number> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { count } = await sb.from("sms_drafts")
    .select("id", { count: "exact", head: true })
    .or("final_body.not.is.null,and(state.eq.rejected)");
  return count ?? 0;
}
