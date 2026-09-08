"use server";

/**
 * Grading real conversations.
 *
 * Split out of simulator.ts, and not for tidiness — simulator-safety.test.ts
 * asserts the simulator writes ONLY to the scenario tables, and it failed the
 * moment grading moved in. The test was right: the simulator is a sandbox that
 * must be unable to touch anything else, and grading real customer
 * conversations is a different job that happens to be reached from the same
 * tab. Two responsibilities in one file is how a guarantee quietly widens.
 */
import { messagingDb } from "./db";


export type GradeQueueItem = {
  id: string;
  transcript: unknown;
  conduct: "good" | "mixed" | "bad" | null;
  outcome: string | null;
  tags: string[];
  piiScrubbed: boolean;
  approved: boolean;
};

/**
 * The next thing to grade.
 *
 * Ungraded first, then graded-but-unexplained — a grade with no reason is
 * worse than no grade, because it counts toward the total while teaching
 * nothing.
 */
export async function nextToGrade(skipIds: string[] = []): Promise<{
  item: GradeQueueItem | null;
  remaining: number;
}> {
  const sb = messagingDb();
  const { data: rows } = await sb
    .from("sms_training_examples")
    .select("id, transcript, conduct, outcome, pii_scrubbed, approved")
    .order("created_at");
  const { data: links } = await sb.from("sms_training_example_tags").select("example_id, tag_key");

  const tagsOf = new Map<string, string[]>();
  for (const l of links ?? []) {
    const list = tagsOf.get(l.example_id) ?? [];
    list.push(l.tag_key);
    tagsOf.set(l.example_id, list);
  }

  const all = (rows ?? []).map((r) => ({
    id: r.id, transcript: r.transcript,
    conduct: r.conduct as GradeQueueItem["conduct"],
    outcome: r.outcome, tags: tagsOf.get(r.id) ?? [],
    piiScrubbed: r.pii_scrubbed, approved: r.approved,
  }));

  const needsWork = all.filter((r) => !r.conduct || r.tags.length === 0);
  const queue = needsWork.filter((r) => !skipIds.includes(r.id));
  return { item: queue[0] ?? null, remaining: needsWork.length };
}

export async function saveGrade(input: {
  exampleId: string;
  conduct: "good" | "mixed" | "bad";
  tagKeys: string[];
  note?: string;
  approve: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = messagingDb();

  const { error } = await sb.from("sms_training_examples").update({
    conduct: input.conduct,
    conduct_note: input.note ?? null,
    // Approving is what makes it eligible for retrieval, so it is a separate
    // decision from grading it — a bad example is still worth keeping, it is
    // just never offered as something to copy.
    approved: input.approve,
    graded_at: new Date().toISOString(),
  }).eq("id", input.exampleId);
  if (error) return { ok: false, error: error.message };

  // Replace rather than append, so removing a tag actually removes it.
  await sb.from("sms_training_example_tags").delete().eq("example_id", input.exampleId);
  if (input.tagKeys.length) {
    const { error: tagErr } = await sb.from("sms_training_example_tags")
      .insert(input.tagKeys.map((tag_key) => ({ example_id: input.exampleId, tag_key })));
    if (tagErr) return { ok: false, error: tagErr.message };
  }
  return { ok: true };
}
