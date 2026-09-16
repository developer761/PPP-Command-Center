"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateStep, setWorkflowActive, setVersionPublished } from "@/lib/messaging/campaign-write";
import { fillMergeFields, unresolvedFields, KNOWN_MERGE_FIELDS } from "@/lib/messaging/merge-fields";
import {
  firstMessageChecks, applyFirstMessageFix, openerStepId, smsSegments, withDisclosure,
} from "@/lib/messaging/first-message";

export type EditableStep = {
  id: string; ordinal: number;
  scheduleMode: "at_launch" | "delay_after_last" | "absolute_on_day";
  delayMinutes: number | null; dayOffset: number | null; timeOfDay: string | null;
  channel: "sms" | "email"; body: string; subject: string | null;
  timing: string;
};

type Workspace = { id: string; name: string; phone_e164: string | null };
type Flow = { id: string; workspaceId: string; name: string; isActive: boolean };

/**
 * Editing a campaign where you are already reading it.
 *
 * No separate edit screen, because the thing you need while changing a message
 * is the rest of the sequence around it — Hatch puts wording in one place and
 * timing in another and you find out they disagree when a customer gets two
 * texts in a minute.
 *
 * Every save says what it actually did, including how many people currently
 * mid-sequence it changed. A change that quietly rewrote what forty customers
 * are about to receive should not feel identical to one that touched nothing.
 */
export default function CampaignEditor({
  steps, workspaces, workflows, versionId, published,
}: {
  steps: EditableStep[];
  workspaces: Workspace[];
  workflows: Flow[];
  versionId: string | null;
  published: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [previewWs, setPreviewWs] = useState(workspaces[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const ws = workspaces.find((w) => w.id === previewWs) ?? workspaces[0];
  const preview = (body: string) =>
    fillMergeFields(body, { workspacePhone: ws?.phone_e164, workspaceName: ws?.name });
  // The first TEXT, which has to say who it is from and how to stop.
  const openerId = openerStepId(steps);

  const publish = async (next: boolean) => {
    if (!versionId) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await setVersionPublished({ versionId, published: next });
      if (!res.ok) { setErr(res.error); return; }
      setNote(next
        ? "Published. Anyone entering from now on gets this sequence."
        : "Unpublished. Nobody new can enter until it is published again.");
      router.refresh();
    } finally { setBusy(false); }
  };

  const toggleFlow = async (f: Flow) => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await setWorkflowActive({ workflowId: f.id, active: !f.isActive });
      if (!res.ok) { setErr(res.error); return; }
      setNote(f.isActive
        ? `Switched off. ${res.alreadyEnrolled} conversation${res.alreadyEnrolled === 1 ? "" : "s"} already running there carry on — turning it off stops new people entering, it does not stop the ones already in.`
        : "Switched on. New leads there enter from now on.");
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {(note || err) && (
        <p className={[
          "rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed",
          err ? "border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700"
              : "border-ppp-green-100 bg-ppp-green-50 text-ppp-charcoal",
        ].join(" ")}>
          {err ?? note}
        </p>
      )}

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold text-ppp-charcoal text-[14px]">The sequence</h2>
            <p className="mt-0.5 text-[12px] text-ppp-charcoal-500">
              Tap a message to change what it says or when it goes.
            </p>
          </div>
          {versionId && (
            <button type="button" onClick={() => void publish(!published)} disabled={busy}
              className={[
                "shrink-0 min-h-[44px] px-3 rounded-xl text-[12.5px] font-semibold touch-manipulation disabled:opacity-40",
                published ? "border border-ppp-charcoal-200 bg-white text-ppp-charcoal-600" : "bg-ppp-charcoal text-white",
              ].join(" ")}>
              {published ? "Unpublish" : "Publish"}
            </button>
          )}
        </div>

        {workspaces.length > 1 && (
          <nav className="flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-ppp-charcoal-100">
            {workspaces.map((w) => (
              <button key={w.id} type="button" onClick={() => setPreviewWs(w.id)}
                aria-pressed={w.id === previewWs}
                className={[
                  "shrink-0 min-h-[36px] px-3 rounded-lg text-[12px] font-medium whitespace-nowrap touch-manipulation",
                  w.id === previewWs ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600",
                ].join(" ")}>
                {w.name}
              </button>
            ))}
          </nav>
        )}

        <ul className="divide-y divide-ppp-charcoal-100">
          {steps.map((s) => (
            <li key={s.id}>
              {editing === s.id ? (
                <StepForm step={s} isOpener={s.id === openerId} preview={preview}
                  onDone={(msg) => { setEditing(null); if (msg) setNote(msg); router.refresh(); }}
                  onError={setErr} onCancel={() => setEditing(null)} />
              ) : (
                <button type="button" onClick={() => { setEditing(s.id); setNote(null); setErr(null); }}
                  className="w-full text-left px-4 py-3 touch-manipulation">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-ppp-charcoal-400">
                      {s.id === openerId && <span className="mr-1.5 rounded bg-ppp-charcoal px-1.5 py-0.5 normal-case tracking-normal text-white">First message</span>}
                      {s.timing}{s.channel === "email" ? " · email" : ""}
                    </span>
                    <span className="shrink-0 text-[11px] text-ppp-charcoal-400">Edit</span>
                  </div>
                  {s.id === openerId && firstMessageChecks(s.body).some((c) => !c.ok) && (
                    <p className="mt-1 text-[12px] text-ppp-orange-700 leading-snug">
                      Missing: {firstMessageChecks(s.body).filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join(" and ")}.
                      It cannot be published like this.
                    </p>
                  )}
                  {s.channel === "email" && (
                    <p className="mt-1 text-[13px] font-semibold text-ppp-charcoal">{s.subject}</p>
                  )}
                  <p className="mt-1 text-[13px] text-ppp-charcoal-600 leading-relaxed whitespace-pre-wrap line-clamp-4">
                    {preview(s.body)}
                  </p>
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Where it runs</h2>
          <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
            Switching one on affects who enters next. It does not add anybody
            who has already been through, and switching off does not stop
            somebody already in the sequence.
          </p>
        </div>
        <ul className="divide-y divide-ppp-charcoal-100">
          {workflows.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => void toggleFlow(f)} disabled={busy}
                aria-pressed={f.isActive}
                className="w-full min-h-[52px] px-4 flex items-center justify-between gap-3 touch-manipulation disabled:opacity-50">
                <span className="text-[13px] text-ppp-charcoal truncate">
                  {workspaces.find((w) => w.id === f.workspaceId)?.name ?? f.name}
                </span>
                <span className={[
                  "shrink-0 h-6 w-10 rounded-full flex items-center px-0.5 transition-colors",
                  f.isActive ? "bg-ppp-charcoal justify-end" : "bg-ppp-charcoal-200 justify-start",
                ].join(" ")}>
                  <span className="h-5 w-5 rounded-full bg-white" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StepForm({
  step, isOpener, preview, onDone, onError, onCancel,
}: {
  step: EditableStep;
  /** The first text in the sequence: must say who it is from and how to stop. */
  isOpener: boolean;
  preview: (body: string) => string;
  onDone: (note: string | null) => void;
  onError: (e: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(step.body);
  const [subject, setSubject] = useState(step.subject ?? "");
  const [mode, setMode] = useState(step.scheduleMode);
  const [delay, setDelay] = useState(String(step.delayMinutes ?? 60));
  const [day, setDay] = useState(String(step.dayOffset ?? 1));
  const [time, setTime] = useState(step.timeOfDay?.slice(0, 5) ?? "10:00");
  const [busy, setBusy] = useState(false);

  const unknown = [...new Set(unresolvedFields(body))]
    .filter((f) => !(KNOWN_MERGE_FIELDS as readonly string[]).includes(f.toLowerCase()));
  const checks = isOpener ? firstMessageChecks(body) : [];
  const openerFails = checks.some((c) => !c.ok);
  // What the customer receives: fields filled for the workspace being viewed,
  // and the opt-out line the gate would add if it were missing.
  const received = step.channel === "sms" && isOpener ? withDisclosure(preview(body)) : preview(body);

  const save = async () => {
    setBusy(true);
    try {
      const res = await updateStep({
        stepId: step.id,
        edit: {
          body, subject: step.channel === "email" ? subject : null,
          scheduleMode: mode,
          delayMinutes: mode === "delay_after_last" ? Number(delay) : null,
          dayOffset: mode === "absolute_on_day" ? Number(day) : null,
          timeOfDay: mode === "absolute_on_day" ? time : null,
        },
      });
      if (!res.ok) { onError(res.error); return; }
      onDone(
        res.rescheduled > 0
          ? `Saved. ${res.rescheduled} message${res.rescheduled === 1 ? "" : "s"} already queued moved to the new time.`
          : res.liveConversationsAffected > 0
            ? `Saved. ${res.liveConversationsAffected} conversation${res.liveConversationsAffected === 1 ? "" : "s"} mid-sequence will get the new wording.`
            : "Saved."
      );
    } catch {
      onError("Could not save that. Nothing was changed.");
    } finally { setBusy(false); }
  };

  return (
    <div className="px-4 py-3 space-y-3 bg-ppp-charcoal-50">
      {step.channel === "email" && (
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
        </label>
      )}

      {isOpener && (
        <div className="rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2.5">
          <p className="text-[12.5px] font-semibold text-ppp-charcoal">The first message a new lead gets</p>
          <p className="mt-0.5 text-[11.5px] text-ppp-charcoal-500 leading-relaxed">
            Write it however you like. Carriers require two things in it, and it
            cannot be saved or published without both.
          </p>
          <ul className="mt-2 space-y-1.5">
            {checks.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center gap-2">
                <span aria-hidden className={[
                  "shrink-0 h-4 w-4 rounded-full flex items-center justify-center text-[10px] font-bold text-white",
                  c.ok ? "bg-ppp-green-600" : "bg-ppp-orange-600",
                ].join(" ")}>{c.ok ? "✓" : "!"}</span>
                <span className={["text-[12.5px]", c.ok ? "text-ppp-charcoal" : "text-ppp-orange-700"].join(" ")}>{c.label}</span>
                {!c.ok && (
                  <button type="button" onClick={() => setBody((b) => applyFirstMessageFix(b, c.key))}
                    className="min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] font-medium text-ppp-charcoal touch-manipulation">
                    {c.fix}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">What it says</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={step.channel === "email" ? 8 : 4}
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] leading-relaxed resize-y" />
        <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400 leading-snug">
          {step.channel === "sms" && <>{[...received].length} characters as sent, {smsSegments(received)} text{smsSegments(received) === 1 ? "" : "s"}. </>}
          You can use {KNOWN_MERGE_FIELDS.map((f) => `{{${f}}}`).join(", ")}.
        </span>
        {unknown.length > 0 && (
          <span className="mt-1 block text-[12px] text-ppp-orange-700 leading-snug">
            Nothing fills in {unknown.map((f) => `{{${f}}}`).join(", ")}, so this message would never send.
          </span>
        )}
      </label>

      {step.channel === "sms" && body.trim() && (
        <div>
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">What the customer sees</span>
          <p className="rounded-2xl rounded-bl-sm bg-white border border-ppp-charcoal-100 px-3 py-2 text-[13px] text-ppp-charcoal leading-relaxed whitespace-pre-wrap max-w-[34rem]">
            {received}
          </p>
        </div>
      )}

      <div>
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">When it goes</span>
        <div className="flex flex-wrap gap-1.5">
          {([
            ["at_launch", "2–5 min after the lead"],
            ["delay_after_last", "After the last one"],
            ["absolute_on_day", "On a set day"],
          ] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setMode(v)} aria-pressed={mode === v}
              className={[
                "min-h-[40px] px-3 rounded-lg text-[12.5px] font-medium border touch-manipulation",
                mode === v ? "bg-ppp-charcoal text-white border-ppp-charcoal" : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-600",
              ].join(" ")}>
              {label}
            </button>
          ))}
        </div>

        {mode === "delay_after_last" && (
          <label className="mt-2 block">
            <span className="block text-[11.5px] text-ppp-charcoal-500 mb-1">Minutes after the previous message</span>
            <input value={delay} onChange={(e) => setDelay(e.target.value)} inputMode="numeric"
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
          </label>
        )}
        {mode === "absolute_on_day" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[11.5px] text-ppp-charcoal-500 mb-1">Days after they enter</span>
              <input value={day} onChange={(e) => setDay(e.target.value)} inputMode="numeric"
                className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
            </label>
            <label className="block">
              <span className="block text-[11.5px] text-ppp-charcoal-500 mb-1">At</span>
              <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="10:00"
                className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
            </label>
          </div>
        )}
        <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-400 leading-snug">
          Changing this moves anything already queued for people mid-sequence,
          so the change is real for them too and not only for whoever comes next.
        </p>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={busy || !body.trim() || unknown.length > 0 || openerFails}
          className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}
          className="min-h-[44px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal touch-manipulation">
          Cancel
        </button>
      </div>
    </div>
  );
}
