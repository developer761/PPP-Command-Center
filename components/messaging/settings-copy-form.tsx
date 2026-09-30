"use client";

/**
 * Copying one workspace's settings onto the others.
 *
 * 32 workspaces, each with hours, weekend policy, reply delays and an
 * after-hours message set by hand. Hatch inherits from the account; we set
 * every one individually, so a policy change is 32 visits and 32 chances to
 * type something slightly different.
 *
 * ── THE PREVIEW IS THE POINT ────────────────────────────────────────────
 *
 * These values decide when a text may lawfully be sent. "Applied to 31
 * workspaces" is not checkable by anybody. So nothing is written until the
 * screen has listed, per workspace, what changes from what — and the change
 * most likely to destroy work, overwriting an after-hours message somebody
 * wrote deliberately, shows its old wording in full.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  COPYABLE_SETTINGS, SETTING_LABELS, NEVER_COPIED,
  type CopyableSetting, type WorkspaceDiff, type WorkspaceSettings,
} from "@/lib/messaging/settings-copy";
import {
  copyableWorkspaces, previewSettingsCopy, applySettingsCopy,
} from "@/lib/messaging/settings-copy-write";

export default function SettingsCopyForm({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [all, setAll] = useState<WorkspaceSettings[] | null>(null);
  const [settings, setSettings] = useState<CopyableSetting[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [diffs, setDiffs] = useState<WorkspaceDiff[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ws = await copyableWorkspaces();
        if (alive) setAll(ws);
      } catch {
        if (alive) setErr("Could not read the other workspaces.");
      }
    })();
    return () => { alive = false; };
  }, []);

  const others = (all ?? []).filter((w) => w.id !== sourceId);
  const source = (all ?? []).find((w) => w.id === sourceId);

  const toggle = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const preview = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await previewSettingsCopy({ sourceId, targetIds: targets, settings });
      if (!res.ok) { setErr(res.error); return; }
      setDiffs(res.diffs);
    } catch {
      setErr("Could not work out what would change.");
    } finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await applySettingsCopy({ sourceId, targetIds: targets, settings });
      if (!res.ok) { setErr(res.error); return; }
      setNote(
        `${res.settingsChanged} setting${res.settingsChanged === 1 ? "" : "s"} changed across `
        + `${res.workspacesChanged} workspace${res.workspacesChanged === 1 ? "" : "s"}. `
        + "This applies to the next message, not to anything already queued."
      );
      setDiffs(null); setTargets([]);
      setAll(await copyableWorkspaces());
      router.refresh();
    } catch {
      setErr("The copy failed. Check the workspaces before assuming nothing changed.");
    } finally { setBusy(false); }
  };

  if (!all) return <p className="text-[12.5px] text-ppp-charcoal-400">Loading…</p>;

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
        Put {source?.name ?? "this workspace"}&rsquo;s settings onto others, rather than
        setting {others.length} of them by hand.
      </p>

      <fieldset>
        <legend className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
          Which settings
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {COPYABLE_SETTINGS.map((s) => (
            <button key={s} type="button" onClick={() => { setSettings(toggle(settings, s)); setDiffs(null); }}
              className={["min-h-[44px] px-3 rounded-lg border text-[12px] touch-manipulation",
                settings.includes(s)
                  ? "border-ppp-charcoal bg-ppp-charcoal text-white"
                  : "border-ppp-charcoal-200 bg-white text-ppp-charcoal-600"].join(" ")}>
              {SETTING_LABELS[s]}
            </button>
          ))}
        </div>
        {/*
          The exclusions, named. "Why can I not also copy the timezone?" is
          the question somebody asks, and the answer is worth having on screen
          rather than in a migration comment.
        */}
        <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-400 leading-relaxed">
          The timezone, number and reply-to address are never copied — {NEVER_COPIED.time_zone}.
        </p>
      </fieldset>

      <fieldset>
        <legend className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
          Onto which workspaces
        </legend>
        <div className="flex flex-wrap gap-1.5">
          <button type="button"
            onClick={() => { setTargets(targets.length === others.length ? [] : others.map((w) => w.id)); setDiffs(null); }}
            className="min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] text-ppp-charcoal-600 touch-manipulation">
            {targets.length === others.length ? "None" : `All ${others.length}`}
          </button>
          {others.map((w) => (
            <button key={w.id} type="button" onClick={() => { setTargets(toggle(targets, w.id)); setDiffs(null); }}
              className={["min-h-[44px] px-3 rounded-lg border text-[12px] touch-manipulation",
                targets.includes(w.id)
                  ? "border-ppp-charcoal bg-ppp-charcoal text-white"
                  : "border-ppp-charcoal-200 bg-white text-ppp-charcoal-600"].join(" ")}>
              {w.name}
            </button>
          ))}
        </div>
      </fieldset>

      {err && <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">{err}</p>}
      {note && <p className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 px-3 py-2 text-[12.5px] text-ppp-charcoal">{note}</p>}

      <button type="button" onClick={() => void preview()}
        disabled={busy || !settings.length || !targets.length}
        className="min-h-[44px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal disabled:opacity-40 touch-manipulation">
        {busy ? "Checking…" : "Show what would change"}
      </button>

      {diffs && (diffs.length === 0 ? (
        <p className="rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2 text-[12.5px] text-ppp-charcoal-600">
          Those workspaces already match. Nothing would change.
        </p>
      ) : (
        <div className="rounded-xl border border-ppp-charcoal-100 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
            <p className="text-[13px] text-ppp-charcoal">
              <strong>{diffs.reduce((n, d) => n + d.changes.length, 0)}</strong> change
              {diffs.reduce((n, d) => n + d.changes.length, 0) === 1 ? "" : "s"} across{" "}
              {diffs.length} workspace{diffs.length === 1 ? "" : "s"}. The rest already match.
            </p>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100 max-h-80 overflow-y-auto">
            {diffs.map((d) => (
              <li key={d.id} className="px-4 py-2">
                <p className="text-[12.5px] font-medium text-ppp-charcoal">{d.name}</p>
                {d.changes.map((c) => (
                  <p key={c.setting} className="text-[12px] text-ppp-charcoal-600 leading-relaxed">
                    {c.label}: <span className="text-ppp-orange-700">{c.from}</span> → {c.to}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          <div className="px-4 py-3 border-t border-ppp-charcoal-100">
            <button type="button" onClick={() => void apply()} disabled={busy}
              className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
              {busy ? "Applying…" : `Apply to ${diffs.length} workspace${diffs.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
