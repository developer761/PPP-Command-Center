"use client";

/**
 * Loading the standing answers from a spreadsheet.
 *
 * The screen this shortcuts: ~25 answers per workspace, one row at a time,
 * one workspace at a time, with the form collapsing after every save. About
 * 555 clicks for 15 workspaces and 1,180 for 32, and the per-workspace
 * answers are the ones most likely to change, so the cost recurs.
 *
 * ── THE PREVIEW IS THE FEATURE ──────────────────────────────────────────
 *
 * This writes sentences the BOT says as PPP, in bulk, across every workspace
 * at once. "312 rows imported" is not a thing anybody can check. So nothing
 * is written until the screen has said how many are NEW, how many REPLACE an
 * answer somebody already wrote, and how many reach every workspace — and
 * the replacing count is the one that matters, because it is the one that
 * destroys work.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { buildFaqImportPreview, type FaqImportPreview, MAX_FAQ_IMPORT_ROWS } from "@/lib/messaging/faq-import";
import { applyFaqImport, faqImportContext } from "@/lib/messaging/faq-import-write";

export default function FaqImportForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [ctx, setCtx] = useState<Awaited<ReturnType<typeof faqImportContext>> | null>(null);
  const [preview, setPreview] = useState<FaqImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // The workspaces and what is already held, so the preview can resolve names
  // and tell adding from replacing.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const c = await faqImportContext();
        if (alive) setCtx(c);
      } catch {
        if (alive) setErr("Could not read the current answers, so a preview would be a guess.");
      }
    })();
    return () => { alive = false; };
  }, []);

  const run = () => {
    if (!ctx) return;
    setPreview(buildFaqImportPreview(text, ctx));
    setResult(null); setErr(null); setShowAll(false);
  };

  const commit = async () => {
    setBusy(true); setErr(null);
    try {
      // The FILE goes to the server, not the parsed rows: the checks that ran
      // here are not allowed to be the only ones that ever ran.
      const res = await applyFaqImport(text);
      if (!res.ok) { setErr(res.error); return; }
      setResult(
        `${res.written} answer${res.written === 1 ? "" : "s"} saved`
        + (res.replaced ? `, ${res.replaced} replacing one already there` : "")
        + (res.skipped ? `, ${res.skipped} skipped` : "")
        + ". They reach the bot within about five minutes."
      );
      setPreview(null);
      setText("");
      // What is held has changed, so a second import must not preview against
      // the old picture.
      setCtx(await faqImportContext());
      router.refresh();
    } catch {
      setErr("The import failed. Run the check again to see what is already in.");
    } finally { setBusy(false); }
  };

  const problems = preview?.rows.filter((r) => r.problem) ?? [];
  const shown = showAll ? problems : problems.slice(0, 5);

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
        Two columns for an answer every workspace gives — <code className="font-mono text-[11.5px]">question, answer</code> —
        or three when it is for one region: <code className="font-mono text-[11.5px]">workspace, question, answer</code>.
        One file can hold both; a row with no workspace is shared.
      </p>
      <p className="text-[11.5px] text-ppp-charcoal-400 leading-relaxed">
        Every row is checked the way a typed answer is: no prices, no naming another company,
        and nothing that depends on where the workspace is can be shared. Nothing is saved
        until you have seen what it would do.
      </p>

      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
          Paste the spreadsheet
        </span>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={6}
          placeholder="workspace,question,answer"
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 font-mono text-base sm:text-[12px] leading-relaxed resize-y"
        />
      </label>

      <button type="button" onClick={run} disabled={!text.trim() || !ctx}
        className="min-h-[44px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal disabled:opacity-40 touch-manipulation">
        {ctx ? "Check the file" : "Loading…"}
      </button>

      {err && (
        <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">{err}</p>
      )}
      {result && (
        <p className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 px-3 py-2 text-[12.5px] text-ppp-charcoal">{result}</p>
      )}

      {preview && (
        <div className="rounded-xl border border-ppp-charcoal-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100 space-y-1">
            <p className="text-[13px] text-ppp-charcoal">
              <strong>{preview.usable}</strong> to save
              {preview.shared > 0 && <>, {preview.shared} of them for every workspace</>}
              {preview.duplicates > 0 && <>, {preview.duplicates} repeated in the file</>}
              {preview.unusable > 0 && <>, {preview.unusable} that cannot be used</>}.
            </p>
            {/*
              ROWS NOBODY LOOKED AT, said out loud.

              The parser slices at MAX_FAQ_IMPORT_ROWS and every count above is
              computed from the slice, so a file of 1,700 answers previewed as
              1,500 and saved 1,500 — a number that differs from no expectation
              anybody holds. Two hundred answers would simply not be there, with
              nothing on the screen disagreeing.
            */}
            {preview.ignoredBeyondLimit > 0 && (
              <p className="text-[12.5px] text-ppp-orange-700">
                {preview.ignoredBeyondLimit} row{preview.ignoredBeyondLimit === 1 ? "" : "s"} past
                the first {MAX_FAQ_IMPORT_ROWS} were not read. Split the file and import the rest
                separately, or none of those answers will exist.
              </p>
            )}
            {/*
              THE LINE THAT MATTERS. Adding is safe; replacing overwrites a
              sentence somebody wrote, and there is no undo. Loud when it is
              non-zero, absent when it is not.
            */}
            {preview.replacing > 0 && (
              <p className="text-[12.5px] text-ppp-orange-700 leading-relaxed">
                {preview.replacing} of these replace an answer already saved. The old wording
                is not kept.
              </p>
            )}
          </div>

          {shown.length > 0 && (
            <ul className="divide-y divide-ppp-charcoal-100">
              {shown.map((r) => (
                <li key={r.line} className="px-4 py-2">
                  <p className="text-[12px] text-ppp-charcoal">
                    <span className="font-mono text-ppp-charcoal-400">Line {r.line}</span>
                    {r.question && <> — {r.question}</>}
                  </p>
                  <p className="text-[12px] text-ppp-orange-700 leading-relaxed">{r.problem}</p>
                </li>
              ))}
              {problems.length > shown.length && (
                <li className="px-4 py-2">
                  <button type="button" onClick={() => setShowAll(true)}
                    className="min-h-[44px] text-[12px] text-ppp-charcoal-500 underline underline-offset-2 touch-manipulation">
                    Show the other {problems.length - shown.length}
                  </button>
                </li>
              )}
            </ul>
          )}

          <div className="px-4 py-3 border-t border-ppp-charcoal-100">
            <button type="button" onClick={() => void commit()} disabled={busy || preview.usable === 0}
              className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
              {busy ? "Saving…" : `Save ${preview.usable} answer${preview.usable === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
