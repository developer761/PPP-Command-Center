"use client";

/**
 * Taking a conversation off the bot, from the thread.
 *
 * The states this has to tell apart are the whole point: the bot has it,
 * somebody needs to take it and nobody has, you have it, or somebody else has
 * it. The old badge said "You have it" for all four of the last three, because
 * nothing ever set an owner and the case could not arise.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { claimConversation, releaseConversation } from "@/lib/messaging/handoff-write";
import {
  TAKEOVER_REASONS, takeoverReasonLabel, heldFor, type TakeoverReason,
} from "@/lib/messaging/handoff";

type Props = {
  conversationId: string;
  state: string;
  holderName: string | null;
  isMine: boolean;
  takeoverAt: string | null;
  botReason: string | null;
};

export function HandoffBar({
  conversationId, state, holderName, isMine, takeoverAt, botReason,
}: Props) {
  const [picking, setPicking] = useState(false);
  const [reason, setReason] = useState<TakeoverReason>("customer_asked_human");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const router = useRouter();

  if (state === "ended") return null;

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setErr(null);
    try {
      const res = await fn();
      if (!res.ok) { setErr(res.error ?? "That did not work."); return; }
      setPicking(false); setConfirmForce(false);
      router.refresh();
    } catch {
      setErr("That did not work. Nothing changed.");
    } finally { setBusy(false); }
  };

  const claim = (force: boolean) =>
    run(() => claimConversation({ conversationId, reason, force }));

  /* ── You have it ───────────────────────────────────────────────── */
  if (isMine) {
    return (
      <div className="rounded-xl border border-ppp-charcoal-200 bg-white px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ppp-charcoal">You have this one</p>
            <p className="mt-0.5 text-[11.5px] text-ppp-charcoal-500 leading-snug">
              The bot will not reply while you hold it
              {takeoverAt ? ` — ${heldFor(takeoverAt, new Date())}` : ""}.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void run(() => releaseConversation({ conversationId }))}
            disabled={busy}
            className="shrink-0 min-h-[44px] px-3.5 rounded-xl border border-ppp-charcoal-200 text-[13px] font-semibold text-ppp-charcoal-700 disabled:opacity-50 touch-manipulation"
          >
            {busy ? "…" : "Give it back"}
          </button>
        </div>
        {err && <p className="mt-2 text-[12px] text-ppp-orange-700 leading-relaxed">{err}</p>}
      </div>
    );
  }

  /* ── Somebody else has it ──────────────────────────────────────── */
  if (state === "human_active" && holderName) {
    return (
      <div className="rounded-xl border border-ppp-charcoal-200 bg-white px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ppp-charcoal truncate">
              {holderName} has this one
            </p>
            <p className="mt-0.5 text-[11.5px] text-ppp-charcoal-500 leading-snug">
              {takeoverAt ? `For ${heldFor(takeoverAt, new Date())}. ` : ""}
              The bot is not replying.
            </p>
          </div>
          {!confirmForce ? (
            <button
              type="button"
              onClick={() => setConfirmForce(true)}
              className="shrink-0 min-h-[44px] px-3 text-[12.5px] font-semibold text-ppp-charcoal-500 touch-manipulation"
            >
              Take it
            </button>
          ) : null}
        </div>

        {confirmForce && (
          <div className="mt-2.5 border-t border-ppp-charcoal-100 pt-2.5">
            <p className="text-[12px] text-ppp-charcoal-600 leading-relaxed">
              Taking it from {holderName} — they will lose it without being asked.
            </p>
            <ReasonPicker reason={reason} setReason={setReason} />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void claim(true)}
                disabled={busy}
                className="min-h-[44px] px-3.5 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500 touch-manipulation"
              >
                {busy ? "…" : "Take it anyway"}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmForce(false); setErr(null); }}
                className="min-h-[44px] px-3 text-[13px] font-medium text-ppp-charcoal-500 touch-manipulation"
              >
                Leave it
              </button>
            </div>
          </div>
        )}
        {err && <p className="mt-2 text-[12px] text-ppp-orange-700 leading-relaxed">{err}</p>}
      </div>
    );
  }

  /* ── Nobody has it: the bot asked for somebody, or you are stepping in ── */
  const waiting = state === "human_active";

  return (
    <div className={[
      "rounded-xl border px-3.5 py-3",
      waiting ? "border-ppp-orange-100 bg-ppp-orange-50" : "border-ppp-charcoal-200 bg-white",
    ].join(" ")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ppp-charcoal">
            {waiting ? "This needs a person" : "The bot has this one"}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ppp-charcoal-600 leading-snug">
            {waiting
              ? botReason
                ? `The bot handed it over: ${takeoverReasonLabel(botReason as TakeoverReason)?.toLowerCase() ?? botReason}. Nobody has claimed it.`
                : "The bot handed it over and nobody has claimed it."
              : "Take it over and the bot stops replying."}
          </p>
        </div>
        {!picking && (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className={[
              "shrink-0 min-h-[44px] px-3.5 rounded-xl text-[13px] font-semibold touch-manipulation",
              waiting ? "bg-ppp-charcoal text-white" : "border border-ppp-charcoal-200 text-ppp-charcoal-700",
            ].join(" ")}
          >
            I&apos;ll take it
          </button>
        )}
      </div>

      {picking && (
        <div className="mt-2.5 border-t border-ppp-charcoal-100 pt-2.5">
          <ReasonPicker reason={reason} setReason={setReason} />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void claim(false)}
              disabled={busy}
              className="min-h-[44px] px-3.5 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500 touch-manipulation"
            >
              {busy ? "Taking…" : "Take it over"}
            </button>
            <button
              type="button"
              onClick={() => { setPicking(false); setErr(null); }}
              className="min-h-[44px] px-3 text-[13px] font-medium text-ppp-charcoal-500 touch-manipulation"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="mt-2 text-[12px] text-ppp-orange-700 leading-relaxed">{err}</p>}
    </div>
  );
}

function ReasonPicker({
  reason, setReason,
}: { reason: TakeoverReason; setReason: (r: TakeoverReason) => void }) {
  return (
    <>
      <p className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
        Why
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {TAKEOVER_REASONS.filter((r) => r !== "manual_review").map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setReason(r)}
            aria-pressed={reason === r}
            className={[
              "min-h-[36px] px-2.5 rounded-lg text-[12px] font-medium border touch-manipulation",
              reason === r
                ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200",
            ].join(" ")}
          >
            {takeoverReasonLabel(r)}
          </button>
        ))}
      </div>
    </>
  );
}
