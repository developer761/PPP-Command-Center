"use server";

/**
 * Actually importing the conversations.
 *
 * This button was hardcoded disabled, with a note saying writing was switched
 * off "until the grade question is settled with Kate". That question is asked
 * and answered in step 1 of the very same form — so the blocker had already
 * been removed and the button stayed off. Kate could preview an import as many
 * times as she liked and never perform one, which made the most important
 * write path in the training module a viewer.
 *
 * Everything the preview promises is enforced here rather than assumed:
 * only the scrubbed text is stored, a row with personal data still in it is
 * refused rather than imported unapproved, and nothing arrives approved —
 * the bot copies a conversation only after a person has said it should.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { buildPreview, type GradeMeaning } from "./training-import";
import { residualPii } from "./pii";

export type ImportResult =
  | {
      ok: true;
      imported: number;
      alreadyThere: number;
      heldBack: number;
      needGrading: number;
    }
  | { ok: false; error: string };

export async function importTrainingRows(input: {
  csv: string;
  meaning: GradeMeaning;
}): Promise<ImportResult> {
  await assertMessagingAccess();

  const preview = buildPreview(input.csv, input.meaning);
  const candidates = preview.rows.filter((r) => r.problems.length === 0 && r.scrubbed.trim());
  if (!candidates.length) {
    return { ok: false, error: "Nothing in that file could be imported. Check the preview above." };
  }

  const sb = messagingDb();
  let imported = 0, alreadyThere = 0, heldBack = 0, needGrading = 0;

  for (const row of candidates) {
    // The preview says personal details are removed before anything is sent.
    // This is where that is true or not, so it is checked again rather than
    // trusted — a row the scrubber could not fully clean is held back.
    if (residualPii(row.scrubbed).length) { heldBack++; continue; }

    const { data: existing } = await sb.from("sms_training_examples")
      .select("id").eq("transcript", row.scrubbed).maybeSingle();
    if (existing) { alreadyThere++; continue; }

    const { error } = await sb.from("sms_training_examples").insert({
      source: "hatch",
      transcript: row.scrubbed,
      // When the grades mean OUTCOME rather than conduct, conduct is left null
      // — the file says how the conversation ended, not whether it was handled
      // well, and treating one as the other is the exact confusion step 1 asks
      // about.
      conduct: input.meaning === "conduct" ? row.conduct : null,
      outcome: input.meaning === "outcome" ? row.outcome ?? row.grade : row.outcome,
      pii_scrubbed: true,
      // Never approved on arrival. A conversation the bot may copy is one a
      // person has read and signed off.
      approved: false,
      graded_at: input.meaning === "conduct" && row.conduct ? new Date().toISOString() : null,
    });
    if (error) return { ok: false, error: `${error.message} (after ${imported} rows)` };

    imported++;
    if (input.meaning !== "conduct" || !row.conduct) needGrading++;
  }

  return { ok: true, imported, alreadyThere, heldBack, needGrading };
}
