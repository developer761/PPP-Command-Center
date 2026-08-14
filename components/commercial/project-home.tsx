import Link from "next/link";
import type { DeliveryTool } from "./delivery-tools-strip";

/**
 * The Project HOME — the landing you get on `?tab=project` with no tool open.
 *
 * Karan 2026-08-14: *"build the Project home: tool cards with live status +
 * quick links."* The deal-overview `DeliveryToolsStrip` is a one-line glance
 * meant to sit above every tab; standing ON the Project tab, that same cramped
 * strip was doing double duty as the home, and a home for a job in delivery
 * wants room — each tool as its own card, its live state spelled out, and the
 * whole card a quick link into the tool.
 *
 * Grouped by delivery PHASE (pre-construction → alongside → close-out), because
 * the question on a job is rarely "where is submittals" — it's "what's blocking
 * me THIS week", and the phase headings answer that before you read a card.
 * The `done / active / todo` accent + count let you see the shape of the whole
 * job in one look: how much is finished, how much hasn't been touched.
 */

const ACCENT: Record<
  DeliveryTool["status"],
  { rail: string; dot: string; state: string; card: string }
> = {
  done: {
    rail: "bg-emerald-400",
    dot: "bg-emerald-500",
    state: "text-emerald-700",
    card: "border-emerald-200 hover:border-emerald-300",
  },
  active: {
    rail: "bg-cc-brand-500",
    dot: "bg-cc-brand-500",
    state: "text-ppp-charcoal-700",
    card: "border-cc-brand-200 hover:border-cc-brand-300",
  },
  todo: {
    rail: "bg-ppp-charcoal-200",
    dot: "bg-ppp-charcoal-300",
    state: "text-ppp-charcoal-400 italic",
    card: "border-ppp-charcoal-100 hover:border-ppp-charcoal-200",
  },
};

export function ProjectHome({
  tools,
  stageMeaning,
}: {
  tools: DeliveryTool[];
  /** What the current stage means — the line that decides when to move on. */
  stageMeaning?: string | null;
}) {
  if (tools.length === 0) return null;

  // Group consecutive tools by phase — the array already arrives in work order
  // (submittals + work order → pre-construction, change orders + billing →
  // alongside, close-out → end), so a running group preserves that sequence.
  const groups: { phase: string; tools: DeliveryTool[] }[] = [];
  for (const t of tools) {
    const last = groups[groups.length - 1];
    if (last && last.phase === t.phase) last.tools.push(t);
    else groups.push({ phase: t.phase, tools: [t] });
  }

  const notStarted = tools.filter((t) => t.status === "todo").length;
  const done = tools.filter((t) => t.status === "done").length;

  return (
    <section aria-label="Project delivery" className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-bold uppercase tracking-widest text-ppp-charcoal-600">
          Delivery
        </h2>
        <span className="text-[11.5px] text-ppp-charcoal-500 tabular-nums">
          {done} done · {notStarted} not started · {tools.length} tools
        </span>
      </header>

      {groups.map((g) => (
        <div key={g.phase} className="space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
            {g.phase}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {g.tools.map((t) => {
              const a = ACCENT[t.status];
              return (
                <Link
                  key={t.key}
                  href={t.href}
                  className={`group relative flex items-stretch gap-3 overflow-hidden rounded-xl border bg-surface pl-0 pr-3.5 py-3 min-h-[44px] transition-colors hover:bg-cc-brand-50/40 ${a.card}`}
                >
                  <span aria-hidden className={`w-1 shrink-0 ${a.rail}`} />
                  <div className="min-w-0 flex-1 py-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13.5px] font-bold text-ppp-charcoal group-hover:text-cc-brand-800 truncate">
                        {t.label}
                      </span>
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                        className="shrink-0 text-ppp-charcoal-300 group-hover:text-cc-brand-600 transition-colors"
                      >
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span aria-hidden className={`h-1.5 w-1.5 rounded-full shrink-0 ${a.dot}`} />
                      <span className={`text-[12px] ${a.state} truncate`}>{t.state}</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}

      {stageMeaning && (
        <p className="rounded-lg bg-ppp-charcoal-50/70 border border-ppp-charcoal-100 px-3.5 py-2.5 text-[12px] text-ppp-charcoal-600">
          <span className="font-semibold text-ppp-charcoal-700">Where it is now:</span> {stageMeaning}
        </p>
      )}
    </section>
  );
}
