"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * Ask — the assistant, reachable from every commercial page.
 *
 * A launcher bottom-right and a panel above it. Deliberately not a full-screen
 * takeover: the usual question is "where do I record a payment", and the answer
 * is more useful next to the page you are already on than instead of it.
 *
 * Answers arrive as markdown links to real pages; those render as Next links so
 * a tap goes straight there without a reload.
 */

type Turn = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "How much are we owed?",
  "Where do I record a payment?",
  "What's the balance on AIREF Building #2?",
  "How do I add a crew member?",
];

/** Render `[text](/path)` as links, and leave everything else alone. */
function withLinks(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\((\/[^)\s]*)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <Link
        key={`l${i++}`}
        href={m[2]}
        className="font-semibold text-cc-brand-700 underline underline-offset-2 hover:text-cc-brand-800"
      >
        {m[1]}
      </Link>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setDraft("");
    const next = [...turns, { role: "user" as const, content: q }];
    setTurns(next);
    setBusy(true);
    try {
      const res = await fetch("/api/commercial/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, history: turns }),
      });
      const data = (await res.json()) as { ok: boolean; answer?: string; error?: string };
      setTurns([
        ...next,
        {
          role: "assistant",
          // A failure is shown in the thread rather than swallowed — an
          // assistant that goes quiet is one people stop asking.
          content: data.ok ? data.answer ?? "" : data.error ?? "Something went wrong.",
        },
      ]);
    } catch {
      setTurns([...next, { role: "assistant", content: "Couldn't reach the assistant just now." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-cc-brand-600 text-white px-4 min-h-[48px] shadow-lg hover:bg-cc-brand-700 transition-colors print:hidden"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="text-[13.5px] font-bold">{open ? "Close" : "Ask"}</span>
      </button>

      {open && (
        <section
          aria-label="Assistant"
          className="fixed bottom-[4.5rem] right-4 z-40 w-[calc(100vw-2rem)] sm:w-[26rem] max-h-[70vh] flex flex-col rounded-xl border border-ppp-charcoal-200 bg-surface shadow-2xl print:hidden"
        >
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
            <p className="text-[13px] font-bold text-ppp-charcoal">Ask</p>
            <p className="text-[11.5px] text-ppp-charcoal-500">
              Where something lives, or what a number is. It reads — it never changes anything.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {turns.length === 0 && (
              <div className="space-y-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => ask(s)}
                    className="block w-full text-left px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] text-ppp-charcoal-600 hover:border-cc-brand-300 hover:text-cc-brand-800 min-h-[38px]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "text-right" : ""}>
                <div
                  className={`inline-block max-w-[92%] text-left rounded-lg px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap ${
                    t.role === "user"
                      ? "bg-cc-brand-600 text-white"
                      : "bg-ppp-charcoal-50 text-ppp-charcoal border border-ppp-charcoal-100"
                  }`}
                >
                  {t.role === "assistant" ? withLinks(t.content) : t.content}
                </div>
              </div>
            ))}
            {busy && <p className="text-[12px] text-ppp-charcoal-400">Looking…</p>}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(draft);
            }}
            className="p-3 border-t border-ppp-charcoal-100 flex items-center gap-2"
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask anything about the platform…"
              className="flex-1 rounded-lg border border-ppp-charcoal-200 bg-surface px-3 text-[12.5px] min-h-[40px]"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="rounded-lg bg-cc-brand-600 text-white px-3 min-h-[40px] text-[12.5px] font-semibold disabled:opacity-40 hover:bg-cc-brand-700"
            >
              Ask
            </button>
          </form>
        </section>
      )}
    </>
  );
}
