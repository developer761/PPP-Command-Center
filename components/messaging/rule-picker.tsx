"use client";

import { useMemo, useState } from "react";
import { addAuditCode, type RuleOption } from "@/lib/messaging/repair-write";

/**
 * Pick the rules a line or a conversation shows, by searching.
 *
 * Kate, 2026-09-15: rules from her sheet like A11 and A23 were "not on here",
 * and she asked for a search field. They were in the database the whole time;
 * the screen only showed our internal rule names, which are not the names she
 * files under. So her codes come first, searchable by code, name or wording,
 * and a code her sheet has that we do not can be added on the spot.
 */
export default function RulePicker({
  options: initialOptions, selected, onChange, unlinkedNote,
}: {
  options: RuleOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Shown on a code that feeds no bot rule yet, when that matters here. */
  unlinkedNote?: string;
}) {
  const [options, setOptions] = useState(initialOptions);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<{ code: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    const score = (o: RuleOption) => {
      const code = (o.code ?? "").toLowerCase();
      if (code && code === s) return 0;
      if (code && code.startsWith(s)) return 1;
      if (o.label.toLowerCase().includes(s)) return 2;
      if (o.description.toLowerCase().includes(s)) return 3;
      return -1;
    };
    return options
      .map((o) => [o, score(o)] as const)
      .filter(([, n]) => n >= 0)
      .sort((a, b) => a[1] - b[1])
      .map(([o]) => o);
  }, [options, q]);

  const typedCode = q.trim().toUpperCase();
  const canOfferAdd = /^[A-Z]{1,3}\d{1,3}$/.test(typedCode) && !options.some((o) => o.code === typedCode);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const add = async () => {
    if (!adding) return;
    setBusy(true); setErr(null);
    try {
      const res = await addAuditCode({ code: adding.code, name: adding.name });
      if (!res.ok) { setErr(res.error); return; }
      setOptions((o) => [res.option, ...o]);
      onChange([...selected, res.option.id]);
      setAdding(null); setQ("");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const o = byId.get(id);
            return (
              <button key={id} type="button" onClick={() => toggle(id)}
                aria-label={`Remove ${o?.code ?? o?.label ?? id}`}
                className="inline-flex items-center gap-1.5 min-h-[44px] pl-2.5 pr-2 rounded-lg bg-ppp-charcoal text-white text-[12px] font-medium touch-manipulation">
                {o?.code ? <strong>{o.code}</strong> : null}
                <span className="max-w-[14rem] truncate">{o?.label ?? id}</span>
                <span aria-hidden className="text-white/70">×</span>
              </button>
            );
          })}
        </div>
      )}

      <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setAdding(null); setErr(null); }}
        placeholder="Search: A11, address, em dash…"
        aria-label="Search rules"
        className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />

      <ul className="max-h-64 overflow-y-auto rounded-lg border border-ppp-charcoal-100 divide-y divide-ppp-charcoal-50">
        {results.map((o) => {
          const on = selected.includes(o.id);
          return (
            <li key={o.id}>
              <button type="button" onClick={() => toggle(o.id)} aria-pressed={on}
                className={[
                  "w-full text-left px-3 py-2 min-h-[44px] touch-manipulation",
                  on ? "bg-ppp-charcoal-50" : "hover:bg-ppp-charcoal-50",
                ].join(" ")}>
                <span className="flex items-start gap-2">
                  <span aria-hidden className={[
                    "mt-0.5 shrink-0 h-4 w-4 rounded border-2 flex items-center justify-center",
                    on ? "border-ppp-charcoal bg-ppp-charcoal" : "border-ppp-charcoal-300",
                  ].join(" ")}>
                    {on && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round"><path d="M20 6L9 17l-5-5" /></svg>}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] text-ppp-charcoal">
                      {o.code && <strong className="mr-1.5">{o.code}</strong>}
                      <span className="font-medium">{o.label}</span>
                      {o.kind === "tag" && <span className="ml-1.5 text-[11px] text-ppp-charcoal-400">Emily&apos;s rule</span>}
                    </span>
                    {o.description && (
                      <span className="block mt-0.5 text-[11.5px] text-ppp-charcoal-500 leading-snug">{o.description}</span>
                    )}
                    {o.kind === "code" && !o.tagKey && unlinkedNote && (
                      <span className="block mt-0.5 text-[11px] text-ppp-orange-700 leading-snug">{unlinkedNote}</span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {results.length === 0 && !canOfferAdd && (
          <li className="px-3 py-3 text-[12.5px] text-ppp-charcoal-500">
            Nothing matches. To add one of your codes, type the code itself, like A40.
          </li>
        )}
      </ul>

      {canOfferAdd && !adding && (
        <button type="button" onClick={() => setAdding({ code: typedCode, name: "" })}
          className="min-h-[44px] px-3 rounded-lg border border-dashed border-ppp-charcoal-300 text-[12.5px] font-medium text-ppp-charcoal-600 touch-manipulation">
          Add {typedCode} from your sheet
        </button>
      )}
      {adding && (
        <div className="rounded-lg border border-ppp-charcoal-100 p-3 space-y-2">
          <label className="block">
            <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
              What your sheet calls {adding.code}
            </span>
            <input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })}
              placeholder="Ask only for the missing part of a partial address"
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px]" />
          </label>
          <p className="text-[11.5px] text-ppp-charcoal-500 leading-snug">
            It is saved with your fix straight away. Karan links it to one of
            Emily&apos;s rules afterwards, so the bot starts learning from it.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => void add()} disabled={busy || !adding.name.trim()}
              className="min-h-[44px] px-3 rounded-lg bg-ppp-charcoal text-white text-[12.5px] font-semibold disabled:opacity-40 touch-manipulation">
              {busy ? "Adding…" : `Add ${adding.code}`}
            </button>
            <button type="button" onClick={() => setAdding(null)}
              className="min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 text-[12.5px] font-medium text-ppp-charcoal-600 touch-manipulation">
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="text-[12px] text-ppp-orange-700">{err}</p>}
    </div>
  );
}
