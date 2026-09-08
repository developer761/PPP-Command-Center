"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveWorkspaceHours } from "@/lib/messaging/workspace-settings";

export type Row = {
  id: string;
  name: string;
  time_zone: string | null;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  send_on_weekends: boolean | null;
  after_hours_autoreply: boolean | null;
  after_hours_message: string | null;
};

const hh = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;

export default function WorkspaceHoursForm({
  row, bound,
}: {
  row: Row;
  bound: { startHour: number; endHour: number };
}) {
  const router = useRouter();
  const [start, setStart] = useState(row.quiet_hours_start?.toString() ?? "");
  const [end, setEnd] = useState(row.quiet_hours_end?.toString() ?? "");
  const [tz, setTz] = useState(row.time_zone ?? "");
  const [weekends, setWeekends] = useState(!!row.send_on_weekends);
  const [autoreply, setAutoreply] = useState(!!row.after_hours_autoreply);
  const [message, setMessage] = useState(row.after_hours_message ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await saveWorkspaceHours({
        workspaceId: row.id, quietStart: start, quietEnd: end, timeZone: tz,
        sendOnWeekends: weekends, afterHoursAutoreply: autoreply, afterHoursMessage: message,
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
          <input value={start} onChange={(e) => setStart(e.target.value)} inputMode="numeric" placeholder="9"
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
        </label>
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Stop sending at</span>
          <input value={end} onChange={(e) => setEnd(e.target.value)} inputMode="numeric" placeholder="20"
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
        </label>
      </div>
      <p className="text-[11.5px] text-ppp-charcoal-500 leading-relaxed">
        24-hour clock, in the workspace&apos;s own timezone. Federal law bounds this
        to {hh(bound.startHour)}–{hh(bound.endHour)} whatever is set here, and
        that bound is applied when the message is sent, not when this is saved —
        so a wider window here does not widen anything.
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

      {err && <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">{err}</p>}
      {note && <p className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 px-3 py-2 text-[12.5px] text-ppp-charcoal">{note}</p>}

      <button type="button" onClick={() => void save()} disabled={busy}
        className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
