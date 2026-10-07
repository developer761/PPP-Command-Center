/**
 * Copying one workspace's settings onto others.
 *
 * ── THE PROBLEM, COUNTED ────────────────────────────────────────────────
 *
 * 32 workspaces, each with sending hours, weekend policy, reply delays and an
 * after-hours message, every one set by hand on its own screen. Hatch has
 * account-level inheritance ("Inherit From: Precision Painting Plus") and we
 * have none, so a policy change is 32 visits and 32 chances to type something
 * slightly different. Configuration drift is not a hypothetical here — it is
 * the default outcome.
 *
 * ── WHY COPYING AND NOT INHERITANCE ─────────────────────────────────────
 *
 * True inheritance would mean NULL on a workspace column meaning "use the
 * account default". Three of these columns are NOT NULL today and the GATE
 * reads them to decide whether a send is lawful — quiet_hours_start,
 * quiet_hours_end, send_on_weekends. Teaching the legal path to handle a null
 * that means "look somewhere else" buys tidiness and costs a class of bug
 * where a missing default silently widens a sending window.
 *
 * Copying keeps every workspace holding concrete values the gate reads
 * exactly as it does today. Nothing about sending changes; only how the
 * values get there. It is also more honest on screen: what a workspace holds
 * is what it holds, rather than a blank that means something.
 *
 * ── WHAT MAY NEVER BE COPIED ────────────────────────────────────────────
 *
 * The same shape as the standing answers' location-bound refusal. A timezone
 * is definitionally regional; copying Eastern onto a California workspace
 * would move its whole sending window three hours and the gate would obey.
 * The reply-to address and the phone number are per-workspace identities.
 * None of them are offered, and they are excluded HERE rather than left out
 * of a form, so a caller that skips the form cannot set them either.
 *
 * Pure. The caller reads and writes.
 */

/** Settings that are company policy and read the same in every region. */
export const COPYABLE_SETTINGS = [
  "quiet_hours_start",
  "quiet_hours_end",
  "send_on_weekends",
  // Copyable for exactly the reason send_on_weekends is: the US federal
  // holidays in holidays.ts fall on the same days in every region PPP works
  // in, so whether to work them is company policy rather than a regional
  // fact. It appeared in NEITHER list, which is the drift this file exists to
  // prevent — the gate enforced it while nothing anywhere could set it.
  "send_on_holidays",
  "after_hours_autoreply",
  "after_hours_message",
  "reply_delay_min_seconds",
  "reply_delay_max_seconds",
] as const;

export type CopyableSetting = (typeof COPYABLE_SETTINGS)[number];

/**
 * Settings that are REGIONAL and must never be copied, with the reason.
 *
 * Named rather than merely omitted: a list of what is excluded and why is the
 * thing somebody reads when they ask "can I not also copy the timezone?".
 */
export const NEVER_COPIED: Record<string, string> = {
  time_zone: "a timezone is where the workspace is — copying it moves the whole sending window",
  phone_e164: "the number customers see and reply to",
  reply_to_email: "the inbox that region's replies go to",
  name: "what the workspace is called",
  origination_identity: "how this workspace is registered to send",
  autosend_enabled: "earned per workspace, deliberately — see migration 178",
};

export const SETTING_LABELS: Record<CopyableSetting, string> = {
  quiet_hours_start: "Sending starts",
  quiet_hours_end: "Sending stops",
  send_on_weekends: "Sends at weekends",
  send_on_holidays: "Sends on public holidays",
  after_hours_autoreply: "Out-of-hours auto-reply",
  after_hours_message: "What the auto-reply says",
  reply_delay_min_seconds: "Shortest reply delay",
  reply_delay_max_seconds: "Longest reply delay",
};

export type WorkspaceSettings = { id: string; name: string } & Partial<
  Record<CopyableSetting, string | number | boolean | null>
>;

export type SettingChange = {
  setting: CopyableSetting;
  label: string;
  from: string;
  to: string;
};

export type WorkspaceDiff = {
  id: string;
  name: string;
  changes: SettingChange[];
};

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "nothing";
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
};

/**
 * What would actually change, per workspace, if this copy were applied.
 *
 * The count of workspaces is not the interesting number — the count of
 * CHANGES is. "Apply to 31 workspaces" reads as a large action when 28 of
 * them already match and nothing would happen to those; it also hides that
 * one of the three real changes is overwriting an after-hours message
 * somebody wrote deliberately.
 */
export function settingsDiff(input: {
  source: WorkspaceSettings;
  targets: WorkspaceSettings[];
  settings: readonly CopyableSetting[];
}): WorkspaceDiff[] {
  const chosen = input.settings.filter((s) => COPYABLE_SETTINGS.includes(s));

  return input.targets
    // Copying a workspace onto itself is a no-op that would still report
    // "1 workspace updated", which is a lie somebody would act on.
    .filter((t) => t.id !== input.source.id)
    .map((t) => ({
      id: t.id,
      name: t.name,
      changes: chosen.flatMap((s) => {
        const from = t[s] ?? null;
        const to = input.source[s] ?? null;
        // Compared loosely on purpose: 9 and "9" out of two different reads of
        // the same column must not read as a change nobody made.
        if (String(from ?? "") === String(to ?? "")) return [];
        return [{ setting: s, label: SETTING_LABELS[s], from: show(from), to: show(to) }];
      }),
    }))
    .filter((d) => d.changes.length > 0);
}

/** The column/value patch to write for one workspace. */
export function patchFor(
  source: WorkspaceSettings, settings: readonly CopyableSetting[]
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const s of settings) {
    if (!COPYABLE_SETTINGS.includes(s)) continue;
    patch[s] = source[s] ?? null;
  }
  return patch;
}
