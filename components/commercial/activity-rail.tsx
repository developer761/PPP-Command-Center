import Link from "next/link";
import {
  dueLabel,
  type ActivityEntry,
  type ActivityFeed,
  type ActivityKind,
} from "@/lib/commercial/opportunities/activity";

/**
 * The Activity rail, from the Salesforce Quote screenshot.
 *
 * Two halves, and the top one is the reason it exists: *Upcoming & Overdue*
 * answers "what is about to be late on this job", which no other surface on the
 * platform answers. The month-grouped history beneath it is the Timeline, but
 * merged — status changes, notes, tasks, emails and proposals in one column
 * rather than one of those five in a tab nobody opens.
 *
 * Renders beside the Overview tab only. The delivery tools — the AIA grid, the
 * submittal log — need the full width, and a rail that squeezes a payment
 * application into two thirds of the screen would cost more than it gives.
 */

const KIND_STYLE: Record<ActivityKind, { dot: string; label: string }> = {
  status: { dot: "bg-cc-brand-500", label: "Status" },
  note: { dot: "bg-ppp-charcoal-400", label: "Note" },
  task: { dot: "bg-ppp-navy", label: "Task" },
  email: { dot: "bg-ppp-blue-500", label: "Email" },
  proposal: { dot: "bg-emerald-500", label: "Proposal" },
};

function Row({ e }: { e: ActivityEntry }) {
  const s = KIND_STYLE[e.kind];
  return (
    <li className="relative pl-4 py-1.5">
      <span
        aria-hidden
        className={`absolute left-0 top-[13px] h-1.5 w-1.5 rounded-full ${s.dot} ${e.done ? "opacity-40" : ""}`}
      />
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[12px] font-semibold leading-snug ${e.done ? "text-ppp-charcoal-400 line-through" : "text-ppp-charcoal"}`}>
          {e.title}
        </span>
        <span className="text-[10px] text-ppp-charcoal-400 tabular-nums shrink-0">
          {e.at.slice(8, 10)}/{e.at.slice(5, 7)}
        </span>
      </div>
      {e.detail && (
        <p className="text-[11px] text-ppp-charcoal-500 leading-snug mt-0.5 line-clamp-2">{e.detail}</p>
      )}
    </li>
  );
}

export function ActivityRail({
  feed,
  todayIso,
  oppId,
}: {
  feed: ActivityFeed;
  todayIso: string;
  oppId: string;
}) {
  return (
    <aside
      aria-label="Activity"
      className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-ppp-charcoal-100">
        <h2 className="text-[13px] font-bold text-ppp-charcoal">Activity</h2>
        <Link
          href={`/commercial/opportunities/${oppId}?tab=activity&sub=tasks`}
          className="text-[11px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[32px] inline-flex items-center px-1 -mx-1"
        >
          Add task
        </Link>
      </div>

      {/* ── Ahead of us. The half no other surface covers. ── */}
      <div className="px-3.5 py-2.5 border-b border-ppp-charcoal-100">
        <div className="flex items-center gap-2 mb-1.5">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
            Upcoming &amp; overdue
          </h3>
          {feed.overdueCount > 0 && (
            <span className="inline-flex items-center h-[17px] px-1.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-[9.5px] font-bold tabular-nums">
              {feed.overdueCount} overdue
            </span>
          )}
        </div>
        {feed.upcoming.length === 0 ? (
          <p className="text-[11.5px] text-ppp-charcoal-400">Nothing scheduled.</p>
        ) : (
          <ul className="space-y-1.5">
            {feed.upcoming.slice(0, 5).map((e) => {
              const d = dueLabel(String(e.dueAt), todayIso);
              return (
                <li key={e.id} className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-semibold text-ppp-charcoal leading-snug min-w-0 truncate">
                    {e.title}
                  </span>
                  <span
                    className={`text-[10.5px] font-bold shrink-0 tabular-nums ${
                      d.overdue ? "text-rose-700" : "text-ppp-charcoal-500"
                    }`}
                  >
                    {d.text}
                  </span>
                </li>
              );
            })}
            {feed.upcoming.length > 5 && (
              <li className="text-[11px] text-ppp-charcoal-500">
                +{feed.upcoming.length - 5} more
              </li>
            )}
          </ul>
        )}
      </div>

      {/* ── Behind us. Every source merged, newest month first. ── */}
      {feed.months.length === 0 ? (
        <p className="px-3.5 py-3 text-[11.5px] text-ppp-charcoal-400">
          Nothing has happened on this job yet.
        </p>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto">
          {feed.months.map((m, i) => (
            <div key={m.key}>
              <div className="sticky top-0 bg-ppp-charcoal-50/90 backdrop-blur px-3.5 py-1 border-y border-ppp-charcoal-100">
                <span className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
                  {m.label}
                </span>
              </div>
              {/* The first month is open; older ones collapse, so a long-running
                  job doesn't bury its recent activity under a year of history.
                  <details> so it costs no JS. */}
              {i === 0 ? (
                <ul className="px-3.5 py-1.5">
                  {m.entries.map((e) => (
                    <Row key={e.id} e={e} />
                  ))}
                </ul>
              ) : (
                <details className="group">
                  <summary className="list-none px-3.5 py-1.5 cursor-pointer text-[11.5px] text-ppp-charcoal-500 hover:text-ppp-charcoal min-h-[44px] sm:min-h-[36px] flex items-center gap-1">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="group-open:rotate-90 transition-transform">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    {m.entries.length} {m.entries.length === 1 ? "entry" : "entries"}
                  </summary>
                  <ul className="px-3.5 pb-1.5">
                    {m.entries.map((e) => (
                      <Row key={e.id} e={e} />
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
