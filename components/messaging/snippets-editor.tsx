"use client";

/**
 * The saved replies a person can drop into a thread. Hatch parity.
 *
 * Hatch gives a rep a named library — "Availability", "Estimate Confirmation
 * - In Person", "Circling Back #1" — and we gave them an empty box, so the
 * same four sentences got retyped all day and each retyping was a chance to
 * word it differently.
 *
 * ── WHAT THIS SCREEN HAS TO SAY OUT LOUD ────────────────────────────────
 *
 * That a snippet is INSERTED, not sent. The person answering reads it, edits
 * it and presses Send, which is exactly why the rules on a snippet are
 * lighter than on a standing answer — a snippet may name a price a person is
 * entitled to discuss, and a standing answer may not, because the bot says
 * that one unsupervised.
 */
import { useEffect, useState } from "react";
import { checkSnippet } from "@/lib/messaging/snippets";
import {
  listSnippets, saveSnippet, setSnippetActive, deleteSnippet, type EditableSnippet,
} from "@/lib/messaging/snippet-write";

export default function SnippetsEditor({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<EditableSnippet[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * A shared snippet is switched off in EVERY workspace. The button sat next
   * to a local one's identical button on a panel headed with one workspace's
   * name, which is how somebody removes a reply from thirty-two regions
   * meaning to fix one. Two clicks in the page rather than window.confirm: a
   * native dialog blocks the tab, and this screen is driven by automation.
   */
  const [confirmingOff, setConfirmingOff] = useState<string | null>(null);
  const [overriding, setOverriding] = useState<EditableSnippet | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = async () => {
    const res = await listSnippets(workspaceId);
    if (res.ok) setRows(res.snippets); else setErr(res.error);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await listSnippets(workspaceId);
      if (!alive) return;
      if (res.ok) setRows(res.snippets); else setErr(res.error);
    })();
    return () => { alive = false; };
  }, [workspaceId]);

  const toggle = async (s: EditableSnippet) => {
    setBusy(s.id); setErr(null); setNote(null);
    setRows((cur) => cur?.map((x) => (x.id === s.id ? { ...x, isActive: !x.isActive } : x)) ?? cur);
    try {
      const res = await setSnippetActive(s.id, !s.isActive);
      if (!res.ok) { setErr(res.error); await reload(); return; }
      // Naming the scope, because the same sentence would otherwise appear
      // whether one workspace or all of them had just changed.
      const scope = s.shared ? " in every workspace" : "";
      setNote(s.isActive ? `Switched off${scope}.` : `Switched on${scope}.`);
    } catch {
      setErr("Could not change that. Nothing was saved.");
      await reload();
    } finally { setBusy(null); }
  };

  const remove = async (s: EditableSnippet) => {
    setBusy(s.id); setErr(null); setNote(null);
    try {
      const res = await deleteSnippet(s.id);
      if (!res.ok) { setErr(res.error); return; }
      setNote(s.shared ? "Deleted from every workspace." : "Deleted.");
      await reload();
    } catch {
      setErr("Could not delete that. Nothing was changed.");
    } finally { setBusy(null); }
  };

  return (
    <div className="p-4 space-y-3">
      <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
        Replies somebody can drop into a thread they have taken over. They are inserted into
        the box, not sent — whoever is answering still reads it, edits it and presses Send.
      </p>
      <p className="text-[11.5px] text-ppp-charcoal-400 leading-relaxed">
        You can use {"{{customer_name}}"}, {"{{workspace_name}}"} and {"{{workspace_phone}}"};
        they are filled in before anybody sees the text. Unlike the standing answers the bot
        gives, a saved reply may discuss a price — a person is entitled to, the bot is not.
      </p>

      {err && <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">{err}</p>}
      {note && <p className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 px-3 py-2 text-[12.5px] text-ppp-charcoal">{note}</p>}

      {rows === null && <p className="text-[12.5px] text-ppp-charcoal-400">Loading…</p>}
      {rows?.length === 0 && editing !== "new" && (
        <p className="text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          No saved replies yet, so anyone answering a thread types every message from scratch.
        </p>
      )}

      {!!rows?.length && (
        <ul className="rounded-xl border border-ppp-charcoal-100 divide-y divide-ppp-charcoal-100 overflow-hidden">
          {rows.map((s) => (
            <li key={s.id} className={editing === s.id ? "bg-ppp-charcoal-50" : ""}>
              {editing === s.id ? (
                <SnippetForm
                  workspaceId={workspaceId} snippet={s}
                  onCancel={() => setEditing(null)}
                  onDone={async (m) => { setEditing(null); setNote(m); setErr(null); await reload(); }}
                  onError={(m) => { setErr(m); setNote(null); }}
                  onDelete={async () => { setEditing(null); await remove(s); }}
                />
              ) : (
                <div className="flex items-start gap-2 p-3">
                  <button type="button"
                    onClick={() => { setEditing(s.id); setErr(null); setNote(null); }}
                    className="flex-1 text-left min-h-[44px] touch-manipulation">
                    <span className={["block text-[13px] font-medium", s.isActive ? "text-ppp-charcoal" : "text-ppp-charcoal-400"].join(" ")}>
                      {s.name}
                    </span>
                    <span className={["mt-0.5 block text-[12px] leading-relaxed", s.isActive ? "text-ppp-charcoal-600" : "text-ppp-charcoal-400"].join(" ")}>
                      {s.body}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      {!s.isActive && (
                        <span className="inline-block text-[11px] font-mono uppercase tracking-wide text-ppp-charcoal-400">
                          off — not offered
                        </span>
                      )}
                      {s.shared && !s.overridden && (
                        <span className="inline-block text-[11px] font-mono uppercase tracking-wide text-ppp-charcoal-500">
                          shared — every workspace
                        </span>
                      )}
                      {s.updatedAt && (
                        <span className="inline-block text-[11px] font-mono uppercase tracking-wide text-ppp-charcoal-400">
                          edited {new Date(s.updatedAt).toLocaleDateString()}
                        </span>
                      )}
                      {s.overridden && (
                        <span className="inline-block text-[11px] font-mono uppercase tracking-wide text-ppp-orange-700">
                          shared — overridden here, this workspace uses its own
                        </span>
                      )}
                    </span>
                  </button>

                  <div className="shrink-0 flex flex-col items-stretch gap-1">
                    {s.shared && confirmingOff === s.id ? (
                      <>
                        <button type="button" disabled={busy === s.id}
                          onClick={() => { setConfirmingOff(null); void toggle(s); }}
                          className="min-h-[44px] px-3 rounded-lg text-[12px] font-semibold bg-ppp-charcoal text-white disabled:opacity-40 touch-manipulation">
                          {s.isActive ? "Yes, everywhere" : "Yes, switch on"}
                        </button>
                        <button type="button" onClick={() => setConfirmingOff(null)}
                          className="min-h-[44px] px-3 rounded-lg text-[12px] text-ppp-charcoal-500 touch-manipulation">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" disabled={busy === s.id}
                        onClick={() => (s.shared ? setConfirmingOff(s.id) : void toggle(s))}
                        className="min-h-[44px] px-3 rounded-lg text-[12px] font-medium bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600 disabled:opacity-40 touch-manipulation">
                        {s.isActive
                          ? (s.shared ? "Switch off everywhere" : "Switch off")
                          : (s.shared ? "Switch on everywhere" : "Switch on")}
                      </button>
                    )}
                    {/*
                      Overriding matched on the NAME, exactly, and retyping it
                      from memory is where that goes wrong — "Circling back"
                      against "Circling Back #1" saves as a second snippet and
                      the rep gets two buttons. This copies the name across.
                    */}
                    {s.shared && !s.overridden && (
                      <button type="button"
                        onClick={() => { setOverriding(s); setEditing("new"); setErr(null); setNote(null); }}
                        className="min-h-[44px] px-3 rounded-lg text-[11.5px] text-ppp-charcoal-500 underline underline-offset-2 touch-manipulation">
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
          <SnippetForm
            workspaceId={workspaceId} snippet={null} overrideOf={overriding}
            onCancel={() => { setEditing(null); setOverriding(null); }}
            onDone={async (m) => { setEditing(null); setOverriding(null); setNote(m); setErr(null); await reload(); }}
            onError={(m) => { setErr(m); setNote(null); }}
          />
        </div>
      ) : (
        <button type="button"
          onClick={() => { setEditing("new"); setErr(null); setNote(null); }}
          className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation">
          Add a saved reply
        </button>
      )}
    </div>
  );
}

function SnippetForm({
  workspaceId, snippet, overrideOf, onDone, onCancel, onError, onDelete,
}: {
  workspaceId: string;
  snippet: EditableSnippet | null;
  overrideOf?: EditableSnippet | null;
  onDone: (note: string) => void | Promise<void>;
  onCancel: () => void;
  onError: (msg: string) => void;
  onDelete?: () => void | Promise<void>;
}) {
  // Verbatim from the shared row when overriding — the match is on the name,
  // so retyping it is where the mistake lives.
  const [name, setName] = useState(snippet?.name ?? overrideOf?.name ?? "");
  const [body, setBody] = useState(snippet?.body ?? "");
  /**
   * NULL until chosen on a new snippet. Not defaulted either way: defaulting
   * to this-workspace silently costs the sharing on most of a real list, and
   * defaulting to shared puts a reply in front of every region that somebody
   * wrote for one. An override is the one case with an obvious answer.
   */
  const [shared, setShared] = useState<boolean | null>(
    snippet?.shared ?? (overrideOf ? false : null)
  );
  const [busy, setBusy] = useState(false);
  /**
   * Switching a shared reply OFF takes two clicks and is reversible. Deleting
   * the same one took ONE and is not. That was backwards, and there is no
   * separate admin tier — anyone who can use a saved reply could permanently
   * remove one from all thirty-two workspaces with two clicks and no prompt.
   */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const problems = checkSnippet({ name, body });
  const touched = name.trim().length > 0 || body.trim().length > 0;
  const shown = touched ? problems : [];

  const save = async () => {
    setBusy(true);
    try {
      const res = await saveSnippet({
        id: snippet?.id, workspaceId, name, body,
        sortOrder: snippet?.sortOrder ?? 0, shared: shared === true,
      });
      if (!res.ok) { onError(res.error); return; }
      await onDone(snippet ? "Saved." : "Added.");
    } catch {
      onError("Could not save. Nothing was changed.");
    } finally { setBusy(false); }
  };

  return (
    <div className="p-3 space-y-2">
      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">What to call it</span>
        {/*
          READ-ONLY WHILE OVERRIDING. The override is matched on the NAME, so
          copying it across only helps if it then stays put — change one
          character here (drop the "#1", fix a capital) and this saves as a
          SECOND snippet instead, which is two buttons with near-identical
          labels saying different things. The exact failure the copy was
          added to prevent.
        */}
        <input value={name} onChange={(e) => setName(e.target.value)}
          readOnly={Boolean(overrideOf)}
          placeholder="Availability"
          className={["w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]",
            overrideOf ? "bg-ppp-charcoal-50 text-ppp-charcoal-500" : ""].join(" ")} />
      </label>
      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">What it puts in the box</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
          placeholder="Hi {{customer_name}}, what days generally work best for you?"
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] leading-relaxed resize-y" />
      </label>

      {overrideOf && (
        <p className="rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2 text-[12px] text-ppp-charcoal-600 leading-relaxed">
          Overriding a shared reply for this workspace only. The name has been copied across
          exactly — it has to match, so leave it and change the text.
        </p>
      )}

      {!snippet && !overrideOf ? (
        <fieldset className="pt-1">
          <legend className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Who gets this one</legend>
          <div className="flex flex-col gap-1.5">
            {[
              { v: false, label: "This workspace only", hint: "Anything specific to this region or its team." },
              { v: true, label: "Every workspace", hint: "The usual case — a reply that reads the same wherever it is sent from." },
            ].map((o) => (
              <label key={String(o.v)} className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="snippet-scope" checked={shared === o.v}
                  onChange={() => setShared(o.v)} className="mt-1 shrink-0" />
                <span className="block">
                  <span className="block text-[12.5px] text-ppp-charcoal">{o.label}</span>
                  <span className="block text-[11.5px] text-ppp-charcoal-400 leading-relaxed">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : snippet?.shared ? (
        <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12px] text-ppp-orange-700 leading-relaxed">
          This is a shared reply. Editing it changes what every workspace sees. To change it
          here only, close this and use &ldquo;Override here&rdquo; on the row.
        </p>
      ) : (
        /*
          A shared row explained itself and a LOCAL one said nothing, so
          somebody who picked the wrong scope had no way to learn that editing
          cannot move it. The only symptom otherwise is the reply never
          appearing in the other workspaces, discovered a week later.
        */
        <p className="rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2 text-[12px] text-ppp-charcoal-600 leading-relaxed">
          This one is for {`this workspace`} only, and that cannot be changed by editing.
          To make it available everywhere, delete it and add it again choosing
          &ldquo;Every workspace&rdquo;.
        </p>
      )}

      {shown.map((p, i) => (
        <p key={i} className="text-[12px] text-ppp-orange-700 leading-relaxed">{p.why}</p>
      ))}

      {/*
        A WARNING, NOT A REFUSAL. A person is entitled to discuss a number the
        estimator has already given, which is why checkSnippet does not block
        a price the way checkFaq does.
        But the argument for the lighter rule is "the reader is the check",
        and a reusable button is precisely what destroys that: the whole point
        is that the same sentence goes out fifty times without anybody
        rethinking it. By the fortieth click nobody is reading. So a price
        here is said once and repeated indefinitely, and nothing updates it
        when the price sheet does.
      */}
      {/\$\s?\d/.test(body) && (
        <p className="rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2 text-[12px] text-ppp-charcoal-600 leading-relaxed">
          This has a price in it. Saved replies are not updated when prices change, and a
          shared one is sent from every workspace — so it will keep going out unchanged
          until somebody edits it. Consider keeping priced replies to this workspace.
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={() => void save()}
          disabled={busy || shown.length > 0 || !touched || shared === null}
          className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}
          className="min-h-[44px] px-4 rounded-lg border border-ppp-charcoal-200 bg-white text-[13px] text-ppp-charcoal-600 disabled:opacity-40 touch-manipulation">
          Cancel
        </button>
        {/* Last and plain: switching off keeps what it said and is almost
            always what somebody means. */}
        {onDelete && (confirmDelete ? (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[12px] text-ppp-orange-700">
              {snippet?.shared ? "Delete from every workspace?" : "Delete it?"}
            </span>
            <button type="button" onClick={() => void onDelete()} disabled={busy}
              className="min-h-[44px] px-3 rounded-lg text-[12.5px] font-semibold bg-ppp-charcoal text-white disabled:opacity-40 touch-manipulation">
              Yes, delete
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}
              className="min-h-[44px] px-3 rounded-lg text-[12.5px] text-ppp-charcoal-500 touch-manipulation">
              Keep it
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy}
            className="ml-auto min-h-[44px] px-3 rounded-lg text-[12.5px] text-ppp-charcoal-500 underline underline-offset-2 disabled:opacity-40 touch-manipulation">
            Delete
          </button>
        ))}
      </div>
    </div>
  );
}
