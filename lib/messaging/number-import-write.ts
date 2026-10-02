"use server";

/**
 * Applying a number assignment.
 *
 * ── ONLY ASYNC EXPORTS LIVE HERE ────────────────────────────────────────
 *
 * A "use server" module may export nothing but async functions. A plain const
 * or type here makes Next drop EVERY export in the module — which tsc cannot
 * see and only a production build catches. MAX_NUMBER_IMPORT_ROWS and the
 * types live in number-import.ts for that reason, the same split faq-import
 * and optout-import use.
 *
 * ── THE PREVIEW IS RE-COMPUTED, NEVER TRUSTED ───────────────────────────
 *
 * The browser sends the FILE, not the rows to write. Sending the parsed rows
 * would make the browser's checks the only ones that ever ran, and a caller
 * posting straight to this action could put one number on two workspaces —
 * which is the state verify-port-readiness exists to refuse and which cannot
 * be unpicked once conversations exist against it.
 *
 * So the text is parsed and checked again here, against the table as it is
 * NOW. That matters more than it does for FAQs: numbers activate hours apart
 * during a port, so the table a preview was drawn from is routinely stale by
 * the time somebody presses the button.
 */
import { assertMessagingAccess } from "./auth";
import { messagingDb } from "./db";
import { buildNumberImportPreview, toNumberAssignments } from "./number-import";

/** What the screen needs to draw a preview: every workspace and what it holds. */
export async function numberImportContext(): Promise<{
  workspaces: { id: string; name: string; phoneE164: string | null }[];
}> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data } = await sb
    .from("sms_sub_accounts")
    .select("id, name, phone_e164")
    .order("name");
  return {
    workspaces: ((data ?? []) as { id: string; name: string; phone_e164: string | null }[])
      .map((w) => ({ id: w.id, name: w.name, phoneE164: w.phone_e164 })),
  };
}

export async function applyNumberImport(text: string): Promise<
  | { ok: true; written: number; unchanged: number; skipped: number }
  | { ok: false; error: string }
> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data } = await sb.from("sms_sub_accounts").select("id, name, phone_e164");
  const workspaces = ((data ?? []) as { id: string; name: string; phone_e164: string | null }[])
    .map((w) => ({ id: w.id, name: w.name, phoneE164: w.phone_e164 }));

  // Re-parsed and re-checked here, against the table as it is now. See above.
  const preview = buildNumberImportPreview(text, workspaces);
  const assignments = toNumberAssignments(preview);

  if (!assignments.length) {
    return {
      ok: false,
      error: preview.unchanged
        ? "Every workspace in that file already holds the number it names. Nothing to change."
        : "Nothing in that file could be imported. The preview says why.",
    };
  }

  /**
   * ONE WORKSPACE AT A TIME, AND THE LAST CHECK IS HERE.
   *
   * Not an upsert of the whole set: these rows carry everything about a
   * workspace — hours, time zone, autosend — and an upsert built from three
   * columns would write NULL over the rest. An UPDATE of one column cannot.
   *
   * The collision re-check runs per row rather than once, because each write
   * changes what the next one collides with. Checking the whole batch up
   * front and then writing would let a file that is internally consistent
   * still land on a number somebody else took while the preview was open.
   */
  let written = 0;
  for (const a of assignments) {
    const { data: clash } = await sb
      .from("sms_sub_accounts")
      .select("id, name")
      .eq("phone_e164", a.phoneE164)
      .neq("id", a.workspaceId)
      .limit(1);
    if (clash?.length) {
      return {
        ok: false,
        error: `${a.phoneE164} belongs to ${(clash[0] as { name: string }).name}. `
          + `${written} workspace(s) were updated before this was found; re-run the preview to see where things stand.`,
      };
    }

    const { error } = await sb
      .from("sms_sub_accounts")
      .update({ phone_e164: a.phoneE164 })
      .eq("id", a.workspaceId);
    if (error) {
      return {
        ok: false,
        error: `Could not set ${a.phoneE164}: ${error.message}. ${written} workspace(s) were updated before this.`,
      };
    }
    written++;
  }

  return { ok: true, written, unchanged: preview.unchanged, skipped: preview.unusable };
}
