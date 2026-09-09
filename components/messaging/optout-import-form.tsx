"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildOptOutPreview, type OptOutPreview } from "@/lib/messaging/optout-import";
import { importOptOuts } from "@/lib/messaging/optout-import-write";

/**
 * Kate loads Hatch's suppression export here.
 *
 * Parsing happens in the browser and the preview can be run as often as she
 * likes without writing anything. She sees exactly what each row became, and
 * how many rows we could not read, BEFORE committing a list that is
 * inconvenient to undo.
 */
export default function OptOutImportForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<OptOutPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const run = () => { setPreview(buildOptOutPreview(text)); setResult(null); setErr(null); };

  const commit = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await importOptOuts(text);
      if (!res.ok) { setErr(res.error); return; }
      setResult(
        `Imported ${res.inserted}. ${res.alreadyPresent} were already suppressed` +
        (res.skipped ? `, ${res.skipped} could not be read.` : ".")
      );
      router.refresh();
    } catch {
      setErr("The import failed. Run the preview again to see what is already in.");
    } finally { setBusy(false); }
  };

  const problems = preview?.rows.filter((r) => r.problem) ?? [];
  const shown = showAll ? problems : problems.slice(0, 5);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
          Paste the export
        </span>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={6}
          placeholder="phone,email,opted_out_at"
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 font-mono text-base sm:text-[12px] leading-relaxed resize-y"
        />
      </label>

      <button type="button" onClick={run} disabled={!text.trim()}
        className="min-h-[44px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal disabled:opacity-40 touch-manipulation">
        Check the file
      </button>

      {preview && (
        <div className="rounded-xl border border-ppp-charcoal-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <p className="text-[13px] text-ppp-charcoal">
              <strong>{preview.usable}</strong> to import
              {preview.emailOnly > 0 && <> — {preview.emailOnly} of them email only</>}
              {preview.duplicates > 0 && <>, {preview.duplicates} repeated in the file</>}
              {preview.unusable > 0 && <>, {preview.unusable} unreadable</>}
            </p>
            <p className="mt-1 text-[11.5px] text-ppp-charcoal-500">
              Read from{" "}
              {preview.detectedHeaders.phone ?? "no phone column"} and{" "}
              {preview.detectedHeaders.email ?? "no email column"}.
            </p>
          </div>

          {problems.length > 0 && (
            <ul className="divide-y divide-ppp-charcoal-100 bg-ppp-orange-50">
              {shown.map((r, i) => (
                <li key={i} className="px-4 py-2 text-[12px] text-ppp-orange-700">
                  {r.problem}
                </li>
              ))}
              {problems.length > 5 && (
                <li>
                  <button type="button" onClick={() => setShowAll((v) => !v)}
                    className="w-full min-h-[44px] text-[12px] font-medium text-ppp-orange-700 touch-manipulation ">
                    {showAll ? "Show fewer" : `Show all ${problems.length}`}
                  </button>
                </li>
              )}
            </ul>
          )}

          <div className="px-4 py-3 bg-ppp-charcoal-50 border-t border-ppp-charcoal-100">
            <p className="text-[12px] text-ppp-charcoal-600 leading-relaxed">
              Importing is safe to repeat. A number already suppressed is
              counted and left alone, so re-importing a fresh export only adds
              what is new.
            </p>
            <button type="button" onClick={() => void commit()} disabled={busy || preview.usable === 0}
              className="mt-2.5 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
              {busy ? "Importing…" : `Import ${preview.usable}`}
            </button>
          </div>
        </div>
      )}

      {err && <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">{err}</p>}
      {result && <p className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 px-3 py-2 text-[12.5px] text-ppp-charcoal">{result}</p>}
    </div>
  );
}
