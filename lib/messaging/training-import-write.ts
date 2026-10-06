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
      /** How many were matched to a workspace. Reported because a silent 0
       *  here is exactly how the missing attribution went unnoticed. */
      attributed: number;
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

  /**
   * THE WORKSPACE COLUMN THE SCREEN SHOWS AS MATCHED, AND NOBODY WROTE.
   *
   * buildPreview parses a workspace column and the import screen renders a
   * green matched-column dot for it, so a person watching believes the region
   * is being carried across. The insert below never wrote it. Checked against
   * production 2026-10-06: 1,286 imported conversations, ZERO with a
   * workspace_id, while every live-rated row has one.
   *
   * The cost is quiet and permanent. Every imported conversation is
   * unattributable to a region, so nothing can ever ask how Nassau is doing
   * against Miami out of the corpus that was imported precisely to answer
   * questions like that.
   *
   * Matched by name with the same normalisation the FAQ importer uses, rather
   * than a second spelling of the same idea. An unmatched or absent name
   * stays null, which is what a shared row should be and is no worse than
   * today.
   */
  const { data: wsRows } = await sb.from("sms_sub_accounts").select("id, name");
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
  const workspaceByName = new Map(
    ((wsRows ?? []) as { id: string; name: string }[]).map((w) => [norm(w.name), w.id])
  );
  let attributed = 0;

  let imported = 0, alreadyThere = 0, heldBack = 0, needGrading = 0;

  for (const row of candidates) {
    // The preview says personal details are removed before anything is sent.
    // This is where that is true or not, so it is checked again rather than
    // trusted — a row the scrubber could not fully clean is held back.
    if (residualPii(row.scrubbed).length) { heldBack++; continue; }

    /**
     * "SAFE TO RUN TWICE" WAS IMPOSSIBLE, AND SILENTLY SO.
     *
     * `transcript` is JSONB (migration 184). `.eq("transcript", row.scrubbed)`
     * hands PostgREST a bare string, which it casts to json and rejects:
     *
     *   400 22P02 invalid input syntax for type json
     *   Token "Customer" is invalid.
     *
     * The `error` half was destructured away, so `existing` came back
     * undefined for EVERY real transcript and every row inserted. There is no
     * unique constraint on transcript, so nothing downstream caught it:
     * `alreadyThere` could only ever be 0, while the import screen promises
     * "Safe to run twice — a conversation already here is counted and skipped
     * rather than added again". Re-importing an export doubled the corpus the
     * bot learns from.
     *
     * JSON.stringify makes it the json literal the column actually holds.
     * Checked against production: the bare form returns 400, the encoded form
     * returns the row.
     *
     * AND THE ERROR IS READ NOW, which is how this survived at all. A lookup
     * that errors is not "no match" — it is a lookup that did not happen, and
     * treating the two alike made a broken filter look like an empty table.
     */
    const { data: existing, error: dupErr } = await sb.from("sms_training_examples")
      .select("id").eq("transcript", JSON.stringify(row.scrubbed)).maybeSingle();
    if (dupErr) {
      return { ok: false, error: `could not check for duplicates: ${dupErr.message} (after ${imported} rows)` };
    }
    if (existing) { alreadyThere++; continue; }

    const workspaceId = row.workspace ? (workspaceByName.get(norm(row.workspace)) ?? null) : null;
    if (workspaceId) attributed++;

    const { error } = await sb.from("sms_training_examples").insert({
      source: "hatch",
      transcript: row.scrubbed,
      // Null when the file names no workspace, or names one we do not have.
      workspace_id: workspaceId,
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

  return { ok: true, imported, alreadyThere, heldBack, needGrading, attributed };
}
