"use client";

/**
 * The composer on a conversation thread.
 *
 * It used to be a disabled textarea saying sending was switched off. That was
 * honest about the carrier but it made the most-visited screen in the platform
 * a place where nothing could be done, and it threw away the one thing a person
 * reading a real conversation is uniquely able to give: what the reply should
 * have been.
 *
 * The carrier is still not connected and this still delivers nothing. What it
 * does instead is bank the correction as a training example, with the real
 * conversation above it as context. That is the same mechanism the repair
 * screen uses, moved to the place where someone actually notices the problem.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveAuthoredExample, type AuthoredTurn } from "@/lib/messaging/authoring";

type Tag = { key: string; section: string; label: string };

export function ThreadTeach({
  turns,
  tags,
  lastWasCustomer,
}: {
  turns: AuthoredTurn[];
  tags: Tag[];
  lastWasCustomer: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  const toggle = (k: string) =>
    setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await saveAuthoredExample({
        turns: [...turns, { who: "agent", text: body.trim() }],
        conduct: "good",
        tagKeys: picked,
        note: note.trim() || undefined,
      });
      if (!res.ok) { setErr(res.error); return; }
      setSaved(true); setBody(""); setPicked([]); setNote("");
      router.refresh();
    } catch {
      setErr("Could not save that. Nothing was written.");
    } finally { setBusy(false); }
  };

  if (saved) {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-ppp-charcoal-100 px-4 pt-3 pb-safe">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3 pb-3">
          <p className="text-[13px] text-ppp-charcoal-700">
            Saved to training. The bot can use this from its next reply.
          </p>
          <button
            type="button"
            onClick={() => { setSaved(false); setOpen(true); }}
            className="shrink-0 min-h-[44px] px-3 text-[13px] font-semibold text-ppp-charcoal-600 touch-manipulation"
          >
            Add another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-ppp-charcoal-100 px-4 pt-3 pb-safe">
      <div className="max-w-3xl mx-auto">
        {!open ? (
          <div className="flex items-center justify-between gap-3 pb-3">
            <p className="text-[12px] text-ppp-charcoal-500 leading-snug">
              Sending is off until the carrier is connected.
            </p>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="shrink-0 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation"
            >
              Teach a reply
            </button>
          </div>
        ) : (
          <div className="pb-3">
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-semibold text-ppp-charcoal">
                {lastWasCustomer
                  ? "What should Emily have said here?"
                  : "What should Emily say next?"}
              </p>
              <button
                type="button"
                onClick={() => { setOpen(false); setErr(null); }}
                className="min-h-[44px] px-2 -mr-2 text-[12px] text-ppp-charcoal-500 touch-manipulation"
              >
                Close
              </button>
            </div>

            <textarea
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              autoFocus
              placeholder="Type the reply as you would send it."
              className="mt-1.5 w-full resize-none rounded-xl border border-ppp-charcoal-200 px-3 py-2.5 text-base sm:text-[14px] text-ppp-charcoal placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-ppp-charcoal-300"
            />

            <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500">
              What does this show? <span className="font-normal normal-case tracking-normal">Pick at least one.</span>
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              {tags.map((t) => {
                const on = picked.includes(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => toggle(t.key)}
                    aria-pressed={on}
                    className={[
                      "min-h-[36px] px-2.5 rounded-lg text-[12px] font-medium border touch-manipulation",
                      on
                        ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                        : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200",
                    ].join(" ")}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this is right (optional)"
              className="mt-2 w-full rounded-xl border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] text-ppp-charcoal placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-ppp-charcoal-300"
            />

            {err && <p className="mt-1.5 text-[12px] text-ppp-orange-700 leading-relaxed">{err}</p>}

            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-[11px] text-ppp-charcoal-500 leading-tight">
                Saved as training, not delivered.
              </p>
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !body.trim() || picked.length === 0}
                className="shrink-0 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500 touch-manipulation"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
