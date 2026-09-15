"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveWorkspaceHours } from "@/lib/messaging/workspace-settings";
import { describeDelay, validateDelay, DEFAULT_DELAY } from "@/lib/messaging/reply-delay";
import { validateReplyTo } from "@/lib/messaging/reply-to";

export type Row = {
  id: string;
  name: string;
  time_zone: string | null;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  send_on_weekends: boolean | null;
  after_hours_autoreply: boolean | null;
  after_hours_message: string | null;
  autosend_enabled: boolean | null;
  reply_delay_min_seconds: number | null;
  reply_delay_max_seconds: number | null;
  reply_to_email: string | null;
};

const hh = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;

/**
 * Hours people can actually pick.
 *
 * Karan: "make it 9-5 like that, how we should enter it, not 9-20, that's
 * confusing." Storage stays 0-23 because that is what the compliance check
 * uses; only the way it is asked for changes. The options stop at the federal
 * bound, so an illegal window cannot be chosen at all rather than being
 * silently narrowed later.
 */
const clock = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? "AM" : "PM"}`;

function hourOptions(from: number, to: number) {
  const out: { value: number; label: string }[] = [];
  for (let h = from; h <= to; h++) out.push({ value: h, label: clock(h) });
  return out;
}

export default function WorkspaceHoursForm({
  row, bound,
}: {
  row: Row;
  bound: { startHour: number; endHour: number };
}) {
  const router = useRouter();
  // Default to the standard window rather than blank: a select with no value
  // shows the first option while storing nothing, which reads as "9am" and
  // saves null.
  const [start, setStart] = useState(String(row.quiet_hours_start ?? 9));
  const [end, setEnd] = useState(String(row.quiet_hours_end ?? 20));
  const [tz, setTz] = useState(row.time_zone ?? "");
  const [weekends, setWeekends] = useState(!!row.send_on_weekends);
  const [autoreply, setAutoreply] = useState(!!row.after_hours_autoreply);
  const [message, setMessage] = useState(row.after_hours_message ?? "");
  const [delayMin, setDelayMin] = useState(String(row.reply_delay_min_seconds ?? DEFAULT_DELAY.minSeconds));
  const [delayMax, setDelayMax] = useState(String(row.reply_delay_max_seconds ?? DEFAULT_DELAY.maxSeconds));
  const [replyTo, setReplyTo] = useState(row.reply_to_email ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const dMin = Number(delayMin), dMax = Number(delayMax);
  const delayProblem = Number.isFinite(dMin) && Number.isFinite(dMax)
    ? validateDelay(Math.round(dMin), Math.round(dMax))
    : "Use whole seconds.";

  const replyToCheck = validateReplyTo(replyTo);
  const replyToProblem = replyToCheck.ok ? null : replyToCheck.error;

  const save = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await saveWorkspaceHours({
        replyDelayMin: Math.round(Number(delayMin) || 0),
        replyDelayMax: Math.round(Number(delayMax) || 0),
        workspaceId: row.id, quietStart: start, quietEnd: end, timeZone: tz,
        sendOnWeekends: weekends, afterHoursAutoreply: autoreply, afterHoursMessage: message,
        replyToEmail: replyTo,
      });
      if (!res.ok) { setErr(res.error); return; }
      setNote(res.clamped
        ? `Saved. The law is narrower than that, so sending still stops outside ${hh(bound.startHour)}–${hh(bound.endHour)}.`
        : "Saved. This applies to the next message.");
      router.refresh();
    } catch {
      setErr("Could not save. Nothing was changed.");
    } finally { setBusy(false); }
  };

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Start sending at</span>
          <select value={start} onChange={(e) => setStart(e.target.value)}
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] bg-white">
            {hourOptions(bound.startHour, bound.endHour - 1).map((o) => (
              <option key={o.value} value={String(o.value)}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Stop sending at</span>
          <select value={end} onChange={(e) => setEnd(e.target.value)}
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] bg-white">
            {hourOptions(bound.startHour + 1, bound.endHour).map((o) => (
              <option key={o.value} value={String(o.value)}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[12px] text-ppp-charcoal-600 leading-relaxed">
        Currently <strong>{clock(Number(start))} to {clock(Number(end))}</strong>,
        in this workspace&apos;s own timezone.
      </p>
      <p className="text-[11.5px] text-ppp-charcoal-500 leading-relaxed">
        The list stops at {clock(bound.startHour)} and {clock(bound.endHour)}
        because federal law does, and that bound is applied when the message is
        sent rather than when this is saved.
      </p>

      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Timezone</span>
        <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/New_York"
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
        <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400">
          Decides what 9am means here. A workspace in the wrong zone texts people at the wrong hour.
        </span>
      </label>

      {[
        ["Send at weekends", weekends, setWeekends] as const,
        ["Auto-reply outside hours", autoreply, setAutoreply] as const,
      ].map(([label, val, set]) => (
        <button key={label} type="button" onClick={() => set(!val)} aria-pressed={val}
          className="w-full min-h-[44px] flex items-center justify-between gap-3 rounded-lg border border-ppp-charcoal-200 px-3 touch-manipulation">
          <span className="text-[13px] text-ppp-charcoal">{label}</span>
          <span className={[
            "shrink-0 h-6 w-10 rounded-full flex items-center px-0.5 transition-colors",
            val ? "bg-ppp-charcoal justify-end" : "bg-ppp-charcoal-200 justify-start",
          ].join(" ")}>
            <span className="h-5 w-5 rounded-full bg-white" />
          </span>
        </button>
      ))}

      {autoreply && (
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">What the auto-reply says</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
            placeholder="Thanks for reaching out! We are currently closed and will get back to you after we open."
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] leading-relaxed resize-y" />
          <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400">
            Kate marked an after-hours reply as a negative on a graded conversation. Leaving this off is a valid answer.
          </span>
        </label>
      )}

      {/* How long before Emily answers.
          Presented in minutes because that is how the decision is discussed
          ("give it two or three minutes"), stored in seconds because that is
          what the delay is drawn in. */}
      <div className="rounded-lg border border-ppp-charcoal-100 p-3">
        <p className="text-[12.5px] font-semibold text-ppp-charcoal">Wait before replying</p>
        <p className="mt-0.5 text-[11.5px] text-ppp-charcoal-500 leading-relaxed">
          How long after the customer&apos;s text Emily&apos;s reply arrives. A
          reply that lands the instant somebody texts reads as a machine. The
          moment is drawn fresh each time from this range, so the gap is never
          identical twice. Both at 0 turns it off.
        </p>

        <div className="mt-2.5 flex items-end gap-2">
          <label className="flex-1 min-w-0">
            <span className="block text-[11.5px] font-medium text-ppp-charcoal-600 mb-1">At least</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number" inputMode="numeric" min={0} max={1800} step={30}
                value={delayMin} onChange={(e) => setDelayMin(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-base sm:text-[13px] tabular-nums" />
              <span className="shrink-0 text-[11.5px] text-ppp-charcoal-500">sec</span>
            </div>
          </label>
          <label className="flex-1 min-w-0">
            <span className="block text-[11.5px] font-medium text-ppp-charcoal-600 mb-1">At most</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number" inputMode="numeric" min={0} max={1800} step={30}
                value={delayMax} onChange={(e) => setDelayMax(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-base sm:text-[13px] tabular-nums" />
              <span className="shrink-0 text-[11.5px] text-ppp-charcoal-500">sec</span>
            </div>
          </label>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {([[30, 90, "30s–1½ min"], [60, 180, "1–3 min"], [120, 300, "2–5 min"], [0, 0, "Off"]] as const)
            .map(([lo, hi, label]) => (
              <button key={label} type="button"
                onClick={() => { setDelayMin(String(lo)); setDelayMax(String(hi)); }}
                aria-pressed={Number(delayMin) === lo && Number(delayMax) === hi}
                className={[
                  "min-h-[36px] px-2.5 rounded-lg text-[12px] font-medium border touch-manipulation",
                  Number(delayMin) === lo && Number(delayMax) === hi
                    ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                    : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200",
                ].join(" ")}>
                {label}
              </button>
            ))}
        </div>

        <p className="mt-2 text-[11.5px] text-ppp-charcoal-600">
          {delayProblem
            ? <span className="text-ppp-orange-700">{delayProblem}</span>
            : describeDelay({ minSeconds: Math.round(Number(delayMin) || 0), maxSeconds: Math.round(Number(delayMax) || 0) })}
        </p>

        {!row.autosend_enabled && Number(delayMax) > 0 && (
          <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-500 leading-relaxed">
            Emily is not sending on her own in this workspace yet, so this has
            no effect here — a reply a person approves goes when they approve
            it. The setting is kept for when autosend is turned on.
          </p>
        )}
      </div>

      {/* Reply-To, not From. Email always goes out from the shared verified
          address, so a customer sees one consistent sender; this decides whose
          inbox their reply lands in. Blank is a valid answer. */}
      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Email replies go to</span>
        <input type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          value={replyTo} onChange={(e) => setReplyTo(e.target.value)}
          placeholder="name@precisionpaintingplus.com"
          aria-invalid={!!replyToProblem}
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
        <span className="mt-1 block text-[11.5px] leading-relaxed">
          {replyToProblem
            ? <span className="text-ppp-orange-700">{replyToProblem}</span>
            : <span className="text-ppp-charcoal-400">
                Emails still come from the shared PPP address. This is the inbox a
                customer&apos;s reply lands in. Leave it blank and replies go to the
                shared address, where they land in the admin Mail inbox tied to no conversation.
              </span>}
        </span>
      </label>

      {err && <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">{err}</p>}
      {note && <p className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 px-3 py-2 text-[12.5px] text-ppp-charcoal">{note}</p>}

      <button type="button" onClick={() => void save()} disabled={busy || !!delayProblem || !!replyToProblem}
        className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
