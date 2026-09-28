"use client";

/**
 * The standing answers one workspace holds. Hatch parity gap 9.
 *
 * Hatch carries roughly 25 curated questions and answers per workspace — "Are
 * you insured?", "Do you have a minimum?", "Where are you located?" — and
 * every one of those is a question that escalates to a person here unless
 * somebody has written the answer down.
 *
 * ── WHAT THIS SCREEN HAS TO SAY OUT LOUD ────────────────────────────────
 *
 * Two things, because neither is guessable:
 *
 *   1. These sentences are BOT-FACING. What gets typed here is repeated to a
 *      customer as PPP's own word, so A1 (never a price) and A18 (never name
 *      another company) are checked on save and the reason is shown.
 *   2. A save is not instant. The prompt build caches for five minutes, in
 *      each server process, so an edit reaches the bot within about that and
 *      not on the next message. Somebody testing an answer in the sandbox
 *      thirty seconds later would otherwise conclude it does not work.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { checkFaq } from "@/lib/messaging/workspace-faq";
import {
  listWorkspaceFaqs, saveWorkspaceFaq, setWorkspaceFaqActive, deleteWorkspaceFaq,
  type EditableFaq,
} from "@/lib/messaging/workspace-faq-write";

export default function WorkspaceFaqs({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [faqs, setFaqs] = useState<EditableFaq[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = async () => {
    const res = await listWorkspaceFaqs(workspaceId);
    if (res.ok) setFaqs(res.faqs);
    else setErr(res.error);
  };

  /**
   * LOAD ONLY. No synchronous resets here.
   *
   * This used to clear the list and the banners before reloading, which is a
   * setState during the effect — and it only existed to handle the workspace
   * changing underneath. The mount site passes `key={r.id}`, so React gives a
   * different workspace a fresh component and there is nothing to reset.
   *
   * `alive` because the answer can land after the component has gone.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await listWorkspaceFaqs(workspaceId);
      if (!alive) return;
      if (res.ok) setFaqs(res.faqs);
      else setErr(res.error);
    })();
    return () => { alive = false; };
  }, [workspaceId]);

  const toggle = async (f: EditableFaq) => {
    setBusy(f.id); setErr(null); setNote(null);
    // Optimistic, rolled back from the server's answer on failure — the same
    // shape workspace-services uses for its per-row toggle.
    setFaqs((cur) => cur?.map((x) => (x.id === f.id ? { ...x, isActive: !x.isActive } : x)) ?? cur);
    try {
      const res = await setWorkspaceFaqActive(f.id, !f.isActive);
      if (!res.ok) { setErr(res.error); await reload(); return; }
      setNote(f.isActive
        ? "Switched off. It stops reaching the bot within about five minutes."
        : "Switched on. It reaches the bot within about five minutes.");
      router.refresh();
    } catch {
      setErr("Could not change that. Nothing was saved.");
      await reload();
    } finally { setBusy(null); }
  };

  const remove = async (f: EditableFaq) => {
    setBusy(f.id); setErr(null); setNote(null);
    try {
      const res = await deleteWorkspaceFaq(f.id);
      if (!res.ok) { setErr(res.error); return; }
      setNote("Deleted.");
      await reload();
      router.refresh();
    } catch {
      setErr("Could not delete that. Nothing was changed.");
    } finally { setBusy(null); }
  };

  return (
    <div className="p-4 space-y-3">
      <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
        Questions this workspace can answer without a person. The bot matches on what the
        customer asks, so write the question the way a customer would say it.
      </p>
      <p className="text-[11.5px] text-ppp-charcoal-400 leading-relaxed">
        Every answer here is said to a customer as PPP. It may not contain a price —
        the estimator gives numbers — and may not name another company. A saved change
        reaches the bot within about five minutes, not on the next message.
      </p>

      {err && (
        <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">{err}</p>
      )}
      {note && (
        <p className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 px-3 py-2 text-[12.5px] text-ppp-charcoal">{note}</p>
      )}

      {faqs === null && <p className="text-[12.5px] text-ppp-charcoal-400">Loading…</p>}

      {faqs?.length === 0 && editing !== "new" && (
        <p className="text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          No standing answers yet, so every question outside the rules and the service
          list hands to a person.
        </p>
      )}

      {!!faqs?.length && (
        <ul className="rounded-xl border border-ppp-charcoal-100 divide-y divide-ppp-charcoal-100 overflow-hidden">
          {faqs.map((f) => (
            <li key={f.id} className={editing === f.id ? "bg-ppp-charcoal-50" : ""}>
              {editing === f.id ? (
                <FaqForm
                  workspaceId={workspaceId}
                  faq={f}
                  onCancel={() => setEditing(null)}
                  onDone={async (msg) => { setEditing(null); setNote(msg); setErr(null); await reload(); router.refresh(); }}
                  onError={(msg) => { setErr(msg); setNote(null); }}
                  onDelete={async () => { setEditing(null); await remove(f); }}
                />
              ) : (
                <div className="flex items-start gap-2 p-3">
                  <button
                    type="button"
                    onClick={() => { setEditing(f.id); setErr(null); setNote(null); }}
                    className="flex-1 text-left min-h-[44px] touch-manipulation"
                  >
                    <span className={["block text-[13px] font-medium", f.isActive ? "text-ppp-charcoal" : "text-ppp-charcoal-400"].join(" ")}>
                      {f.question}
                    </span>
                    <span className={["mt-0.5 block text-[12px] leading-relaxed", f.isActive ? "text-ppp-charcoal-600" : "text-ppp-charcoal-400"].join(" ")}>
                      {f.answer}
                    </span>
                    {!f.isActive && (
                      <span className="mt-1 inline-block text-[11px] font-mono uppercase tracking-wide text-ppp-charcoal-400">
                        off — not sent to the bot
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggle(f)}
                    disabled={busy === f.id}
                    className="shrink-0 min-h-[44px] px-3 rounded-lg text-[12px] font-medium bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600 disabled:opacity-40 touch-manipulation"
                  >
                    {f.isActive ? "Switch off" : "Switch on"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing === "new" ? (
        <div className="rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50">
          <FaqForm
            workspaceId={workspaceId}
            faq={null}
            onCancel={() => setEditing(null)}
            onDone={async (msg) => { setEditing(null); setNote(msg); setErr(null); await reload(); router.refresh(); }}
            onError={(msg) => { setErr(msg); setNote(null); }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { setEditing("new"); setErr(null); setNote(null); }}
          className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation"
        >
          Add an answer
        </button>
      )}

    </div>
  );
}

/**
 * One row's form. Owns its own fields and its own busy flag, and reports up —
 * the shape campaign-editor uses, so the two read the same.
 *
 * The A1/A18 check runs as you type, from the SAME pure function the server
 * calls on save and the loader calls at read time. Three callers, one rule:
 * anything else and the screen would approve a sentence the bot then drops.
 */
function FaqForm({
  workspaceId, faq, onDone, onCancel, onError, onDelete,
}: {
  workspaceId: string;
  faq: EditableFaq | null;
  onDone: (note: string) => void | Promise<void>;
  onCancel: () => void;
  onError: (msg: string) => void;
  /** Only for a row that exists. Switching off is usually what people mean. */
  onDelete?: () => void | Promise<void>;
}) {
  const [question, setQuestion] = useState(faq?.question ?? "");
  const [answer, setAnswer] = useState(faq?.answer ?? "");
  const [busy, setBusy] = useState(false);

  const problems = checkFaq({ question, answer });
  const touched = question.trim().length > 0 || answer.trim().length > 0;
  // Only complain about emptiness once they have started; a blank new form
  // is not a mistake yet.
  const shown = touched ? problems : [];

  const save = async () => {
    setBusy(true);
    try {
      const res = await saveWorkspaceFaq({
        id: faq?.id, workspaceId, question, answer, sortOrder: faq?.sortOrder ?? 0,
      });
      if (!res.ok) { onError(res.error); return; }
      await onDone(faq ? "Saved. It reaches the bot within about five minutes."
                       : "Added. It reaches the bot within about five minutes.");
    } catch {
      onError("Could not save. Nothing was changed.");
    } finally { setBusy(false); }
  };

  return (
    <div className="p-3 space-y-2">
      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
          What the customer asks
        </span>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Are you insured?"
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]"
        />
      </label>
      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
          What the bot may say back
        </span>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={3}
          placeholder="Yes — fully licensed and insured, and we can send the certificate over."
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] leading-relaxed resize-y"
        />
        <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400">
          One message long. It is sent as written.
        </span>
      </label>

      {shown.map((p, i) => (
        <p key={i} className="text-[12px] text-ppp-orange-700 leading-relaxed">
          {p.why}
        </p>
      ))}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || shown.length > 0 || !touched}
          className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-[44px] px-4 rounded-lg border border-ppp-charcoal-200 bg-white text-[13px] text-ppp-charcoal-600 disabled:opacity-40 touch-manipulation"
        >
          Cancel
        </button>
        {/*
          Last, and deliberately plain. Switching an answer off is almost
          always what somebody means — it stops reaching the bot and what it
          said is still readable — so delete does not get to look like the
          obvious button.
        */}
        {onDelete && (
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={busy}
            className="ml-auto min-h-[44px] px-3 rounded-lg text-[12.5px] text-ppp-charcoal-500 underline underline-offset-2 disabled:opacity-40 touch-manipulation"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
