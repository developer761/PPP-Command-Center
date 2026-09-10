"use server";

/**
 * Taking a graded sandbox conversation out — into training, or as a record.
 *
 * Karan's idea, and it resolves a tension rather than ignoring one. Migration
 * 195 ruled that simulated conversations must NOT become training examples:
 * "a simulated customer is somebody's idea of a customer, and training on
 * those teaches the bot to handle an imagination."
 *
 * That rule is about SILENT promotion — grading something in a sandbox and
 * having it quietly become material the bot copies. An explicit export is a
 * different act: a person has read the exchange and decided it is worth
 * teaching. Two things keep the original rule intact anyway:
 *
 *   Every row is source='simulated', for ever. It can never be mistaken for a
 *   real conversation, and anything that wants only real ones can still ask.
 *
 *   The bot's replies in the sandbox are GENUINELY the bot's. Only the
 *   customer's side is invented, which is the half migration 195 was worried
 *   about — and a human who writes "should have kept it short" is describing
 *   the bot's real behaviour, not an imagined customer's.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { scrub, residualPii } from "./pii";
import {
  formatAuditSheet, formatAuditCsv, transcriptOnly, conductFor, reasonFrom,
  type AuditSheet,
} from "./audit-sheet";

export type ExportResult =
  | { ok: true; id: string; redacted: string[] }
  | { ok: false; error: string };

export async function exportScenarioToTraining(input: {
  sheet: AuditSheet;
  /** Which of Emily's rules this shows. Without one it teaches nothing. */
  tagKeys: string[];
}): Promise<ExportResult> {
  await assertMessagingAccess();

  const conduct = conductFor(input.sheet.overall);
  if (!conduct) return { ok: false, error: "Say whether it went well before sending it to training." };
  if (!input.sheet.turns.length) return { ok: false, error: "There is no conversation to send." };
  if (!input.tagKeys.length) {
    // Same rule the hand-written path enforces: an untagged example inflates
    // the corpus total while teaching none of Emily's rules.
    return { ok: false, error: "Pick at least one rule this shows." };
  }

  // Scrubbed even though it is invented — people type real names and numbers
  // into a sandbox without thinking, and "it was only a test" is not a defence
  // once it is in a table.
  const raw = transcriptOnly(input.sheet);
  const { text, found } = scrub(raw);
  const leftover = residualPii(text);
  if (leftover.length) {
    return { ok: false, error: `That still looks like real customer data (${leftover.join(", ")}).` };
  }

  const sb = messagingDb();
  const { data, error } = await sb.from("sms_training_examples").insert({
    source: "simulated",
    transcript: text,
    conduct,
    conduct_note: reasonFrom(input.sheet),
    pii_scrubbed: true,
    // Only a good one is something to copy, and even then it is marked
    // simulated so anything that wants real conversations can exclude it.
    approved: conduct === "good",
    graded_at: new Date().toISOString(),
  }).select("id").single();
  if (error) return { ok: false, error: error.message };

  const { error: tagErr } = await sb.from("sms_training_example_tags").insert(
    input.tagKeys.map((tag_key) => ({
      example_id: data.id, tag_key, note: reasonFrom(input.sheet),
    }))
  );
  if (tagErr) return { ok: false, error: tagErr.message };

  return { ok: true, id: data.id, redacted: found.filter((f) => f.count > 0).map((f) => f.kind) };
}

/**
 * The same conversation as a file, in Kate's layout.
 *
 * Returned as text rather than written anywhere: the browser saves it, and a
 * server that wrote export files would be a second place conversations live.
 */
export async function scenarioAsSheet(input: { sheet: AuditSheet; as: "sheet" | "csv" }): Promise<
  { ok: true; filename: string; body: string } | { ok: false; error: string }
> {
  await assertMessagingAccess();
  if (!input.sheet.turns.length) return { ok: false, error: "There is no conversation to export." };

  // Scrubbed on the way out too. A file leaves the building.
  const scrubbed: AuditSheet = {
    ...input.sheet,
    turns: input.sheet.turns.map((t) => ({ ...t, text: scrub(t.text).text })),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  return input.as === "csv"
    ? { ok: true, filename: `connect-hub-audit-${stamp}.csv`, body: formatAuditCsv(scrubbed) }
    : { ok: true, filename: `connect-hub-audit-${stamp}.txt`, body: formatAuditSheet(scrubbed) };
}
