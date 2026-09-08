"use server";

/**
 * Writing the imported suppression list.
 *
 * Kept apart from the parser so the parsing can be run and re-run against a
 * file as often as anybody likes with no possibility of a write. That matters
 * here more than usual: the preview is the thing Kate checks before committing
 * a list she cannot easily un-commit.
 */
import { messagingDb } from "./db";
import { buildOptOutPreview, toOptOutRecords, MAX_IMPORT_ROWS } from "./optout-import";
import { assertMessagingAccess } from "./auth";

export type ImportOutcome = {
  ok: true;
  inserted: number;
  alreadyPresent: number;
  skipped: number;
} | { ok: false; error: string };

export async function importOptOuts(csv: string): Promise<ImportOutcome> {
  await assertMessagingAccess();
  const preview = buildOptOutPreview(csv);
  const records = toOptOutRecords(preview);
  if (!records.length) return { ok: false, error: "Nothing in that file could be imported." };

  // Inserts run one at a time so a duplicate cannot take the good rows down
  // with it, which means a very large paste would run for minutes and be cut
  // off by the platform partway through — a partial import with no way to tell
  // how far it got. Kate's export is around 213 rows; this is well above that
  // and well below a timeout. Refusing with a number is better than accepting
  // and stopping silently.
  if (records.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      error: `That file has ${records.length} rows to import and this handles ${MAX_IMPORT_ROWS} at a time. Split it and import the parts — already-suppressed rows are skipped, so overlapping is fine.`,
    };
  }

  const sb = messagingDb();
  let inserted = 0, alreadyPresent = 0;

  // One at a time rather than a bulk insert. A bulk insert fails whole and
  // takes the good rows down with the duplicates, and the duplicates are
  // expected — this list gets re-imported every time Kate exports a fresh one.
  // Slower, and the only version that is safe to run twice.
  for (const r of records) {
    const { error } = await sb.from("sms_opt_outs").insert({
      ...r,
      opted_out_at: r.opted_out_at ?? new Date().toISOString(),
    });
    if (!error) { inserted++; continue; }
    // 23505: already suppressed on that channel, which is the desired state.
    if (error.code === "23505") { alreadyPresent++; continue; }
    return { ok: false, error: `${error.message} (after ${inserted} rows)` };
  }

  return {
    ok: true,
    inserted,
    alreadyPresent,
    skipped: preview.rows.length - records.length,
  };
}

/** How many numbers and addresses are suppressed right now. */
export async function suppressionCount(): Promise<{ sms: number; email: number }> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data } = await sb.from("sms_opt_outs")
    .select("channel, phone_e164, email, opted_in_at");
  const active = (data ?? []).filter((r) => !r.opted_in_at);
  return {
    sms: active.filter((r) => r.phone_e164).length,
    email: active.filter((r) => r.email).length,
  };
}
