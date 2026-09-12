"use client";

import { useState } from "react";
import { buildPreview, type ImportPreview, type GradeMeaning } from "@/lib/messaging/training-import";
import { importTrainingRows } from "@/lib/messaging/training-import-write";
import { useRouter } from "next/navigation";

/**
 * Kate's upload screen.
 *
 * Parsing and scrubbing happen in the browser, before anything is sent
 * anywhere. That is deliberate: this is customer conversation data, and she
 * should be able to see exactly what a row becomes — and change her mind —
 * without the raw text having left her machine first.
 *
 * Three steps, in the order that makes the decisions unavoidable:
 *   1. what do your grades MEAN
 *   2. paste the data
 *   3. look at what it became, then import
 */
export default function TrainingImportForm() {
  const [meaning, setMeaning] = useState<GradeMeaning | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const doImport = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const res = await importTrainingRows({ csv: text, meaning: meaning ?? "conduct" });
      if (!res.ok) { setErr(res.error); return; }
      setResult(
        `Imported ${res.imported}.` +
        (res.alreadyThere ? ` ${res.alreadyThere} were already here.` : "") +
        (res.heldBack ? ` ${res.heldBack} held back for still containing personal details.` : "") +
        (res.needGrading ? ` ${res.needGrading} need grading before the bot can use them.` : "")
      );
      router.refresh();
    } catch {
      setErr("The import failed. Run the check again to see what is already in.");
    } finally { setBusy(false); }
  };

  const run = () => setPreview(buildPreview(text, meaning ?? "conduct"));

  const problemRows = preview?.rows.filter((r) => r.problems.length > 0) ?? [];
  const shown = showAll ? preview?.rows ?? [] : (preview?.rows ?? []).slice(0, 5);

  return (
    <div className="space-y-4">
      {/* STEP 1 — asked first, and blocking, because it is the one thing that
          cannot be inferred from the file and changes what the import means. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 flex items-center gap-2">
          <Step n={1} done={meaning !== null} />
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">What do your ratings mean?</h2>
        </div>
        <div className="px-4 py-3">
          <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
            A conversation can be handled well and still lose an unqualified
            lead, or handled badly and book anyway because the customer had
            already decided. They go in different columns, and if we train on
            the wrong one the bot learns to copy luck.
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {([
              ["conduct", "How well it was handled", "Did the assistant ask the right things, in the right order, and stop when it should?"],
              ["outcome", "Whether it booked", "Did the conversation end in an appointment?"],
            ] as const).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                onClick={() => { setMeaning(value); setPreview(null); }}
                aria-pressed={meaning === value}
                className={[
                  "text-left rounded-xl border-2 px-3.5 py-3 min-h-[44px] touch-manipulation transition-colors",
                  meaning === value
                    ? "border-ppp-charcoal bg-ppp-charcoal-50"
                    : "border-ppp-charcoal-100 hover:border-ppp-charcoal-200",
                ].join(" ")}
              >
                <span className="block text-[13px] font-semibold text-ppp-charcoal">{label}</span>
                <span className="block mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">{hint}</span>
              </button>
            ))}
          </div>
          {meaning === null && (
            <p className="mt-2.5 text-[12px] text-ppp-charcoal-500">
              If your sheet has both, pick the one the good/mixed/bad column
              describes — the other can be imported separately.
            </p>
          )}
        </div>
      </section>

      {/* STEP 2 */}
      <section className={`rounded-xl border bg-white overflow-hidden ${meaning ? "border-ppp-charcoal-100" : "border-ppp-charcoal-100 opacity-50 pointer-events-none"}`}>
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 flex items-center gap-2">
          <Step n={2} done={text.trim().length > 0} />
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Paste the export</h2>
        </div>
        <div className="px-4 py-3">
          <p className="text-[12.5px] text-ppp-charcoal-500 leading-relaxed mb-2.5">
            From Google Sheets: select everything including the header row and
            copy. Column names do not need to match anything — they get matched
            automatically and you can check below.
          </p>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null); }}
            rows={6}
            placeholder="Date,Customer Name,Conversation,Rating…"
            aria-label="Paste CSV export"
            className="w-full rounded-xl border border-ppp-charcoal-200 px-3 py-2.5 text-base sm:text-[13px] font-mono text-ppp-charcoal placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
          />
          <button
            type="button"
            onClick={run}
            disabled={!text.trim() || !meaning}
            className="mt-2.5 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500 disabled:cursor-not-allowed"
          >
            Check it
          </button>
        </div>
      </section>

      {/* STEP 3 */}
      {preview && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 flex items-center gap-2">
            <Step n={3} done={false} />
            <h2 className="font-semibold text-ppp-charcoal text-[14px]">Check before importing</h2>
          </div>

          <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {([
              ["Rows", preview.rows.length, null],
              ["Ready", preview.usable, null],
              ["Need a look", problemRows.length, problemRows.length > 0],
              ["Duplicates", preview.duplicates, preview.duplicates > 0],
            ] as const).map(([label, n, warn]) => (
              <div key={label} className={`rounded-lg px-3 py-2.5 ${warn ? "bg-ppp-orange-50" : "bg-ppp-charcoal-50"}`}>
                <div className={`text-[19px] font-bold tabular-nums leading-none ${warn ? "text-ppp-orange-700" : "text-ppp-charcoal"}`}>{n}</div>
                <div className={`mt-1 text-[11px] ${warn ? "text-ppp-orange-700" : "text-ppp-charcoal-500"}`}>{label}</div>
              </div>
            ))}
          </div>

          {/* What matched which column. If detection is wrong, everything
              downstream is wrong, so it is shown rather than assumed. */}
          <div className="px-4 pb-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1.5">Columns matched</p>
            <ul className="space-y-1">
              {(["transcript", "grade", "name", "workspace", "outcome", "date"] as const).map((k) => (
                <li key={k} className="flex items-center gap-2 text-[12.5px]">
                  <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${preview.detected[k] ? "bg-ppp-green" : "bg-ppp-charcoal-300"}`} />
                  <span className="text-ppp-charcoal-500 w-[86px] shrink-0">{k}</span>
                  <span className={`truncate min-w-0 ${preview.detected[k] ? "text-ppp-charcoal font-medium" : "text-ppp-charcoal-400 italic"}`}>
                    {preview.detected[k] ?? "not found"}
                  </span>
                </li>
              ))}
            </ul>
            {preview.gradeValues.length > 0 && (
              <p className="mt-2.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
                Ratings found: {preview.gradeValues.map((v) => <code key={v} className="mx-0.5 px-1 rounded bg-ppp-charcoal-50">{v}</code>)}
              </p>
            )}
          </div>

          {/* Before and after, on real rows. The point of the screen: Kate
              sees exactly what leaves her machine. */}
          <div className="border-t border-ppp-charcoal-100">
            <p className="px-4 pt-3 text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
              Before and after scrubbing
            </p>
            <ul className="divide-y divide-ppp-charcoal-50">
              {shown.map((r) => (
                <li key={r.line} className="px-4 py-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] font-mono text-ppp-charcoal-400">row {r.line}</span>
                    {r.conduct && <Tag>{r.conduct}</Tag>}
                    {r.outcome && <Tag>{r.outcome}</Tag>}
                    {r.piiFound.map((f) => <Tag key={f.kind}>{f.count} {f.kind}</Tag>)}
                  </div>
                  <p className="text-[12.5px] text-ppp-charcoal-400 line-through line-clamp-2 leading-snug">{r.transcript || "(empty)"}</p>
                  <p className="mt-1 text-[12.5px] text-ppp-charcoal leading-snug line-clamp-3">{r.scrubbed || "(empty)"}</p>
                  {r.problems.map((p) => (
                    <p key={p} className="mt-1.5 text-[12px] text-ppp-orange-700">{p}</p>
                  ))}
                </li>
              ))}
            </ul>
            {preview.rows.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="w-full min-h-[44px] text-[13px] font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 border-t border-ppp-charcoal-100 touch-manipulation"
              >
                {showAll ? "Show fewer" : `Show all ${preview.rows.length} rows`}
              </button>
            )}
          </div>

          <div className="px-4 py-3 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50">
            <p className="text-[12px] text-ppp-charcoal-600 leading-relaxed">
              Importing stores the scrubbed version only. Nothing becomes a
              training example until it is also approved — rows flagged above
              come in unapproved so they can be looked at rather than blocking
              the rest.
            </p>
            <button
              type="button"
              onClick={() => void doImport()}
              disabled={busy || preview.usable === 0}
              className="mt-2.5 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500 touch-manipulation"
            >
              {busy ? "Importing…" : `Import ${preview.usable} rows`}
            </button>
            <p className="mt-1.5 text-[11px] text-ppp-charcoal-500">
              Safe to run twice — a conversation already here is counted and
              skipped rather than added again.
            </p>
            {err && <p className="mt-1.5 text-[12px] text-ppp-orange-700 leading-relaxed">{err}</p>}
            {result && <p className="mt-1.5 text-[12px] text-ppp-charcoal-700 leading-relaxed">{result}</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function Step({ n, done }: { n: number; done: boolean }) {
  return (
    <span className={[
      "shrink-0 h-5 w-5 rounded-full text-[11px] font-bold flex items-center justify-center",
      done ? "bg-ppp-green-50 text-ppp-green-700" : "bg-ppp-charcoal-100 text-ppp-charcoal-500",
    ].join(" ")}>
      {n}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-ppp-charcoal-50 px-2 py-0.5 text-[10.5px] font-medium text-ppp-charcoal-600">
      {children}
    </span>
  );
}
