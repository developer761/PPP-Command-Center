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
  /**
   * The row whose "switch off" is waiting for a second click.
   *
   * A shared row is switched off in EVERY workspace, and the button sat next
   * to a local row's identical button with identical wording. The realistic
   * sequence: the warranty answer reads wrong for Nassau, somebody switches
   * it off meaning to fix Nassau, and thirty-two regions stop answering
   * warranty questions with nothing on screen having said so.
   *
   * Two clicks in the page rather than window.confirm: a native dialog blocks
   * the whole tab, and this screen is driven by automation during testing.
   */
  const [confirmingOff, setConfirmingOff] = useState<string | null>(null);
  /** A shared question being copied down into this workspace. */
  const [overriding, setOverriding] = useState<EditableFaq | null>(null);
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
      // Naming the scope, because the same sentence used to appear whether
      // one workspace or all thirty-two had just changed.
      const scope = f.shared ? " in EVERY workspace" : "";
      setNote(f.isActive
        ? `Switched off${scope}. It stops reaching the bot within about five minutes.`
        : `Switched on${scope}. It reaches the bot within about five minutes.`);
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
      setNote(f.shared ? "Deleted from every workspace." : "Deleted.");
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
                    <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      {!f.isActive && (
                        <span className="inline-block text-[11px] font-mono uppercase tracking-wide text-ppp-charcoal-400">
                          off — not sent to the bot
                        </span>
                      )}
                      {f.shared && !f.overridden && (
                        <span className="inline-block text-[11px] font-mono uppercase tracking-wide text-ppp-charcoal-500">
                          shared — every workspace
                        </span>
                      )}
                      {/*
                        The one state somebody has to be told about. A shared
                        row this workspace has replaced still appears in the
                        list, and without this it reads as the answer in use —
                        so the screen would say one thing and the bot do
                        another, which is the worst way to be wrong.
                      */}
                      {f.overridden && (
                        <span className="inline-block text-[11px] font-mono uppercase tracking-wide text-ppp-orange-700">
                          shared — overridden here, the bot uses this workspace&apos;s answer
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="shrink-0 flex flex-col items-stretch gap-1">
                    {/*
                      A SHARED ROW'S BUTTON DOES NOT LOOK LIKE A LOCAL ROW'S.
                      It sat here with identical wording, on a panel headed
                      with ONE workspace's name, and switched the answer off
                      in all of them. The note afterwards said "It stops
                      reaching the bot" — not "in every workspace".
                    */}
                    {f.shared && confirmingOff === f.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => { setConfirmingOff(null); void toggle(f); }}
                          disabled={busy === f.id}
                          className="min-h-[44px] px-3 rounded-lg text-[12px] font-semibold bg-ppp-charcoal text-white disabled:opacity-40 touch-manipulation"
                        >
                          {f.isActive ? "Yes, everywhere" : "Yes, switch on"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingOff(null)}
                          className="min-h-[44px] px-3 rounded-lg text-[12px] text-ppp-charcoal-500 touch-manipulation"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => (f.shared ? setConfirmingOff(f.id) : void toggle(f))}
                        disabled={busy === f.id}
                        className="min-h-[44px] px-3 rounded-lg text-[12px] font-medium bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600 disabled:opacity-40 touch-manipulation"
                      >
                        {f.isActive
                          ? (f.shared ? "Switch off everywhere" : "Switch off")
                          : (f.shared ? "Switch on everywhere" : "Switch on")}
                      </button>
                    )}
                    {/*
                      OVERRIDING HAD TO BE TYPED FROM MEMORY, CHARACTER EXACT.
                      The only explanation lived inside a shared row's edit
                      form, and the Add form opened blank — so "What's your
                      warranty?" against a shared "What is your warranty?"
                      saved happily as a SECOND question, and the bot got two
                      warranty answers and picked one. An apostrophe was
                      enough. This copies the question down verbatim.
                    */}
                    {f.shared && !f.overridden && (
                      <button
                        type="button"
                        onClick={() => { setOverriding(f); setEditing("new"); setErr(null); setNote(null); }}
                        className="min-h-[44px] px-3 rounded-lg text-[11.5px] text-ppp-charcoal-500 underline underline-offset-2 touch-manipulation"
                      >
                        Override here
                      </button>
                    )}
                  </div>
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
            overrideOf={overriding}
            onCancel={() => { setEditing(null); setOverriding(null); }}
            onDone={async (msg) => { setEditing(null); setOverriding(null); setNote(msg); setErr(null); await reload(); router.refresh(); }}
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
  workspaceId, faq, overrideOf, onDone, onCancel, onError, onDelete,
}: {
  workspaceId: string;
  faq: EditableFaq | null;
  /** The shared row being copied down, when this form was opened by "Override here". */
  overrideOf?: EditableFaq | null;
  onDone: (note: string) => void | Promise<void>;
  onCancel: () => void;
  onError: (msg: string) => void;
  /** Only for a row that exists. Switching off is usually what people mean. */
  onDelete?: () => void | Promise<void>;
}) {
  // Verbatim from the shared row when overriding — the match is exact, so
  // retyping it is where the mistake was.
  const [question, setQuestion] = useState(faq?.question ?? overrideOf?.question ?? "");
  const [answer, setAnswer] = useState(faq?.answer ?? "");
  /**
   * CHOSEN ON A NEW ROW ONLY. An existing row keeps the tier it was saved in.
   *
   * Moving a row between tiers is a workspace_id change that can collide with
   * a row in the destination, and the half-states it opens — editing a shared
   * answer from one workspace and turning it local, with fourteen other
   * workspaces silently losing it — are not worth the convenience. Deleting
   * and re-adding is two clicks and it is obvious what happened.
   */
  /**
   * NULL UNTIL CHOSEN, ON A NEW ROW. Not defaulted.
   *
   * It defaulted to "this workspace only", which is the wrong answer for
   * about two thirds of a real list — so the form reset to the expensive
   * option after every save and a shared answer took a deliberate click whose
   * only job was to undo the default. Missing that click is silent: the row
   * saves as local and the only symptom is typing it thirty-one more times.
   *
   * Defaulting the OTHER way is worse — an answer accidentally shared is
   * wrong in front of customers in thirty-one regions. So neither: choose.
   * An override is the one case with an obvious answer, and it is local.
   */
  const [shared, setShared] = useState<boolean | null>(
    faq?.shared ?? (overrideOf ? false : null)
  );
  const [busy, setBusy] = useState(false);

  // `shared` goes in, so the one problem that only applies to a shared row —
  // a location-bound question or answer — appears as you type rather than on
  // save.
  const problems = checkFaq({ question, answer, shared: shared === true });
  const touched = question.trim().length > 0 || answer.trim().length > 0;
  // Only complain about emptiness once they have started; a blank new form
  // is not a mistake yet.
  const shown = touched ? problems : [];

  const save = async () => {
    setBusy(true);
    try {
      const res = await saveWorkspaceFaq({
        id: faq?.id, workspaceId, question, answer, sortOrder: faq?.sortOrder ?? 0,
        shared: shared === true,
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
        {/*
          READ-ONLY WHILE OVERRIDING, the same as the snippets editor beside
          it and for the same reason, which that file states: the override is
          matched on the normalised QUESTION, so the copy only helps if it then
          stays put. Change one character here — drop a word, fix a capital —
          and this saves as a SECOND answer rather than an override. The badge
          never appears, nothing looks wrong, and the bot holds two answers to
          one question with row order deciding which it gives.

          The note below used to ASK the person to leave it alone. A sentence
          is not a guard.
        */}
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          readOnly={Boolean(overrideOf)}
          placeholder="Are you insured?"
          className={[
            "w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]",
            overrideOf ? "bg-ppp-charcoal-50 text-ppp-charcoal-500" : "",
          ].join(" ")}
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

      {/*
        NEW ROWS ONLY — see the `shared` state above for why a tier does not
        move. An existing row states its tier instead of offering a control
        that would do something surprising.
      */}
      {overrideOf && (
        <p className="rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2 text-[12px] text-ppp-charcoal-600 leading-relaxed">
          Overriding a shared answer for this workspace only. The question is
          fixed because the override is matched on it — change the answer
          underneath. To ask something different, add a new answer instead.
        </p>
      )}

      {!faq && !overrideOf ? (
        <fieldset className="pt-1">
          <legend className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
            Who uses this answer
          </legend>
          <div className="flex flex-col gap-1.5">
            {[
              { v: false, label: "This workspace only", hint: "Anything that depends on where you are — service area, the office, which zips." },
              { v: true, label: "Every workspace", hint: "Company policy that reads the same everywhere — insurance, EPA, warranty, payment terms." },
            ].map((o) => (
              <label key={String(o.v)} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="faq-scope"
                  checked={shared === o.v}
                  onChange={() => setShared(o.v)}
                  className="mt-1 shrink-0"
                />
                <span className="block">
                  <span className="block text-[12.5px] text-ppp-charcoal">{o.label}</span>
                  <span className="block text-[11.5px] text-ppp-charcoal-400 leading-relaxed">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : faq?.shared && (
        <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12px] text-ppp-orange-700 leading-relaxed">
          This is a shared answer. Editing it changes what every workspace says.
          To change it for this workspace only, close this and use
          &ldquo;Override here&rdquo; on the row instead.
        </p>
      )}

      {shown.map((p, i) => (
        <p key={i} className="text-[12px] text-ppp-orange-700 leading-relaxed">
          {p.why}
        </p>
      ))}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => void save()}
          // `shared === null` is a new row whose tier nobody has picked yet.
          disabled={busy || shown.length > 0 || !touched || shared === null}
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
