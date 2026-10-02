"use client";

/**
 * Assigning ported numbers to workspaces from a spreadsheet.
 *
 * The screen this shortcuts: a hand-written UPDATE against production per
 * workspace, during a port that activates numbers hours apart. That is how
 * +18888156464 reached ZZ TEST.
 *
 * ── THE PREVIEW IS THE FEATURE ──────────────────────────────────────────
 *
 * The failure here is not a rejected file, it is a SILENT MISROUTE: a
 * workspace sending from an area code its customers do not recognise, with
 * replies landing in another region's queue, and nothing looking broken. So
 * the screen says which workspaces CHANGE number before anything is written —
 * that count is the one worth reading, because a change is what sends the
 * wrong region's leads somewhere else.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { buildNumberImportPreview, type NumberImportPreview } from "@/lib/messaging/number-import";
import { applyNumberImport, numberImportContext } from "@/lib/messaging/number-import-write";

/** +15163448418 -> (516) 344-8418, so a person can check it against a port order. */
function pretty(e164: string | null): string {
  if (!e164) return "—";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export default function NumberImportForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [ctx, setCtx] = useState<Awaited<ReturnType<typeof numberImportContext>> | null>(null);
  const [preview, setPreview] = useState<NumberImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Every workspace and what it holds, so the preview can resolve names and
  // tell a change from a no-op.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const c = await numberImportContext();
        if (alive) setCtx(c);
      } catch {
        if (alive) setErr("Could not read the current numbers, so a preview would be a guess.");
      }
    })();
    return () => { alive = false; };
  }, []);

  const run = () => {
    if (!ctx) return;
    setPreview(buildNumberImportPreview(text, ctx.workspaces));
    setResult(null); setErr(null); setShowAll(false);
  };

  const commit = async () => {
    setBusy(true); setErr(null);
    try {
      // The FILE goes to the server, not the parsed rows. Numbers activate
      // hours apart during a port, so the table this previewed against is
      // routinely stale by now and the server checks again.
      const res = await applyNumberImport(text);
      if (!res.ok) { setErr(res.error); return; }
      setResult(
        `${res.written} workspace${res.written === 1 ? "" : "s"} updated`
        + (res.unchanged ? `, ${res.unchanged} already correct` : "")
        + (res.skipped ? `, ${res.skipped} skipped` : "")
        + "."
      );
      setPreview(null);
      setText("");
      setCtx(await numberImportContext());
      router.refresh();
    } catch {
      setErr("The import failed. Run the check again to see where things stand.");
    } finally { setBusy(false); }
  };

  const problems = preview?.rows.filter((r) => r.problem) ?? [];
  const shown = showAll ? problems : problems.slice(0, 5);
  const changes = preview?.rows.filter((r) => !r.problem && r.currentPhone !== r.phoneE164) ?? [];

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
        Two columns — <code className="font-mono text-[11.5px]">workspace, number</code>. The number
        can be written any way: <code className="font-mono text-[11.5px]">(516) 344-8418</code>,{" "}
        <code className="font-mono text-[11.5px]">516-344-8418</code> or{" "}
        <code className="font-mono text-[11.5px]">+15163448418</code>.
      </p>
      <p className="text-[11.5px] text-ppp-charcoal-400 leading-relaxed">
        A number already held by another workspace is refused, unless the file also moves
        that workspace off it. Two workspaces on one number cannot be told apart when a
        reply comes in.
      </p>

      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
          Paste the spreadsheet
        </span>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={6}
          placeholder="workspace,number"
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
              <strong>{changes.length}</strong> to change
              {preview.unchanged > 0 && <>, {preview.unchanged} already correct</>}
              {preview.unusable > 0 && <>, {preview.unusable} that cannot be used</>}.
            </p>
            {/*
              THE LINE THAT MATTERS. Giving a number to a workspace that had
              none is safe. Taking one it already had and replacing it moves
              where a whole region's replies land, and there is no undo.
            */}
            {preview.replacing > 0 && (
              <p className="text-[12.5px] text-ppp-orange-700 leading-relaxed">
                {preview.replacing} of these replace a number a workspace is already using.
                Anyone texting the old number stops reaching that workspace.
              </p>
            )}
          </div>

          {changes.length > 0 && (
            <ul className="divide-y divide-ppp-charcoal-100">
              {changes.map((r) => (
                <li key={`c-${r.line}`} className="px-4 py-2 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[12px] text-ppp-charcoal">{r.workspaceName}</span>
                  <span className="font-mono text-[11.5px] text-ppp-charcoal-400">
                    {pretty(r.currentPhone)} → {pretty(r.phoneE164)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {shown.length > 0 && (
            <ul className="divide-y divide-ppp-charcoal-100 border-t border-ppp-charcoal-100">
              {shown.map((r) => (
                <li key={r.line} className="px-4 py-2">
                  <p className="text-[12px] text-ppp-charcoal">
                    <span className="font-mono text-ppp-charcoal-400">Line {r.line}</span>
                    {r.workspaceName && <> — {r.workspaceName}</>}
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
            <button type="button" onClick={() => void commit()} disabled={busy || changes.length === 0}
              className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
              {busy ? "Saving…" : `Update ${changes.length} workspace${changes.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
