"use server";

/**
 * Applying a settings copy.
 *
 * Only async exports here — a "use server" module that exports a const makes
 * Next drop every export in the file, invisibly to tsc. The lists, labels and
 * the diff live in settings-copy.ts for that reason.
 *
 * ── THE DIFF IS RE-COMPUTED HERE ────────────────────────────────────────
 *
 * The browser sends which workspaces and which settings, never the values.
 * Values are read from the source workspace on this side, and the excluded
 * list is enforced on this side, so a caller posting straight to this action
 * cannot set a timezone or a phone number — the two that would move a whole
 * sending window or silently change who a customer is talking to.
 */
import { assertMessagingAccess } from "./auth";
import { messagingDb } from "./db";
import {
  COPYABLE_SETTINGS, settingsDiff, patchFor,
  type CopyableSetting, type WorkspaceDiff, type WorkspaceSettings,
} from "./settings-copy";

const COLUMNS = `id, name, ${COPYABLE_SETTINGS.join(", ")}`;

/** Every workspace and the settings that can be copied between them. */
export async function copyableWorkspaces(): Promise<WorkspaceSettings[]> {
  await assertMessagingAccess();
  const { data } = await messagingDb()
    .from("sms_sub_accounts").select(COLUMNS).order("name");
  return (data ?? []) as unknown as WorkspaceSettings[];
}

/** What would change, without changing anything. */
export async function previewSettingsCopy(input: {
  sourceId: string;
  targetIds: string[];
  settings: CopyableSetting[];
}): Promise<{ ok: true; diffs: WorkspaceDiff[] } | { ok: false; error: string }> {
  await assertMessagingAccess();
  const all = await copyableWorkspaces();
  const source = all.find((w) => w.id === input.sourceId);
  if (!source) return { ok: false, error: "That workspace no longer exists." };

  const targets = all.filter((w) => input.targetIds.includes(w.id));
  return { ok: true, diffs: settingsDiff({ source, targets, settings: input.settings }) };
}

export async function applySettingsCopy(input: {
  sourceId: string;
  targetIds: string[];
  settings: CopyableSetting[];
}): Promise<
  | { ok: true; workspacesChanged: number; settingsChanged: number }
  | { ok: false; error: string }
> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const all = await copyableWorkspaces();
  const source = all.find((w) => w.id === input.sourceId);
  if (!source) return { ok: false, error: "That workspace no longer exists." };

  // Filtered against the allow-list here, not in the browser. A setting that
  // is not copyable is not copyable however the call arrives.
  const settings = input.settings.filter((s) => COPYABLE_SETTINGS.includes(s));
  if (!settings.length) return { ok: false, error: "Nothing was selected to copy." };

  const targets = all.filter((w) => input.targetIds.includes(w.id));
  const diffs = settingsDiff({ source, targets, settings });
  if (!diffs.length) {
    return { ok: false, error: "Those workspaces already match — nothing to do." };
  }

  /**
   * ONLY THE WORKSPACES THAT WOULD ACTUALLY CHANGE.
   *
   * Writing the same values back onto the 28 that already match would bump
   * their updated_at and make a settings audit read as though somebody
   * changed every workspace today. The diff already knows which ones matter.
   */
  const patch = { ...patchFor(source, settings), updated_at: new Date().toISOString() };
  let settingsChanged = 0;
  for (const d of diffs) {
    const { error } = await sb.from("sms_sub_accounts").update(patch).eq("id", d.id);
    if (error) {
      return {
        ok: false,
        // Named, because a half-applied copy is worse than a failed one and
        // somebody has to know where it stopped.
        error: `Stopped at ${d.name}: ${error.message}. The workspaces before it were changed.`,
      };
    }
    settingsChanged += d.changes.length;
  }

  return { ok: true, workspacesChanged: diffs.length, settingsChanged };
}
