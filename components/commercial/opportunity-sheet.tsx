import Link from "next/link";

/**
 * The SHEET view for the opportunities list (Karan 2026-08-14): "a filter that's
 * just a simple list view like Salesforce — literally just the opp titles and
 * stuff... a sheet view." A dense spreadsheet of every opportunity, one row
 * each, scannable top to bottom, no cards. By-GC and List stay as alternatives.
 *
 * As of 2026-08-17 this is the DEFAULT view — which made its phone behaviour
 * suddenly matter a lot more. An 820px table in a sideways scroller is fine as
 * something you opted into on a laptop; it is not fine as the first thing the
 * CEO sees on his phone every morning, which is a hard requirement here. So
 * below `sm` the same rows render as cards and the table is hidden outright.
 * One view, two shapes — rather than a phone default that differs from the
 * desktop default, which would make "what am I looking at" a question.
 */

export type OppSheetRow = {
  id: string;
  href: string;
  title: string;
  account: string;
  status: string;
  statusTone: "pre" | "won" | "lost" | "delivery" | "neutral";
  source: string;
  value: string;
  owner: string;
  /** "12d" in-status, or "—". */
  age: string;
};

// These are lane buckets, not raw statuses, so they can't route through
// statusPillTone directly — but they must AGREE with it. `won` was emerald
// here and navy on Account 360 and the project card, so one won job read as
// three different states across three surfaces in one session.
const STATUS_TONE: Record<OppSheetRow["statusTone"], string> = {
  pre: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200",
  delivery: "bg-ppp-blue-50 text-ppp-blue-800 border-ppp-blue-200",
  won: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200",
  lost: "bg-rose-50 text-rose-700 border-rose-200",
  neutral: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200",
};

export function OpportunitySheet({ rows }: { rows: OppSheetRow[] }) {
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
      {/* One horizontal scroller for the whole table — the header scrolls with
          the body so columns stay aligned on a phone. */}
      {/* ── Phone: cards. No sideways scrolling for the default view. ── */}
      <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={r.href} className="flex flex-col gap-1.5 px-3.5 py-3 min-h-[44px] active:bg-cc-brand-50/60">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[13.5px] font-semibold text-ppp-charcoal leading-snug min-w-0">
                  {r.title}
                </span>
                <span className="text-[13px] font-bold tabular-nums text-ppp-charcoal shrink-0">
                  {r.value}
                </span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap ${STATUS_TONE[r.statusTone]}`}>
                  {r.status}
                </span>
                <span className="text-[11.5px] text-ppp-charcoal-500 truncate min-w-0">{r.account}</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-ppp-charcoal-400">
                <span className="truncate min-w-0">{r.owner}</span>
                {r.age !== "—" && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums shrink-0">{r.age} in stage</span>
                  </>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-ppp-charcoal-100 bg-ppp-charcoal-50/60 text-left">
              <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-ppp-charcoal-500 sticky left-0 bg-ppp-charcoal-50/60 min-w-[220px]">Opportunity</th>
              <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-ppp-charcoal-500 min-w-[150px]">Account</th>
              <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-ppp-charcoal-500 min-w-[130px]">Status</th>
              <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-ppp-charcoal-500 min-w-[110px]">Source</th>
              <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-ppp-charcoal-500 text-right min-w-[100px]">Value</th>
              <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-ppp-charcoal-500 min-w-[130px]">Owner</th>
              <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-ppp-charcoal-500 text-right min-w-[70px] tabular-nums">In stage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ppp-charcoal-100">
            {rows.map((r) => (
              <tr key={r.id} className="group hover:bg-cc-brand-50/40 transition-colors">
                <td className="px-3 py-2 sticky left-0 bg-surface group-hover:bg-cc-brand-50/40 transition-colors">
                  <Link href={r.href} className="font-semibold text-ppp-charcoal group-hover:text-cc-brand-800 hover:underline block truncate max-w-[280px]">
                    {r.title}
                  </Link>
                </td>
                <td className="px-3 py-2 text-ppp-charcoal-700 truncate max-w-[180px]">{r.account}</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold border whitespace-nowrap ${STATUS_TONE[r.statusTone]}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-ppp-charcoal-600 truncate max-w-[130px]">{r.source}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-ppp-charcoal">{r.value}</td>
                <td className="px-3 py-2 text-ppp-charcoal-600 truncate max-w-[150px]">{r.owner}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ppp-charcoal-500">{r.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
