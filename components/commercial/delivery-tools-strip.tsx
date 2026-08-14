import Link from "next/link";

/**
 * The delivery tools, surfaced on the deal itself once the job is won.
 *
 * Karan 2026-08-13: *"we're in delivery now and there's no work order or
 * closeout and warranty or anything like that here."* They existed — one click
 * down, inside the Project tab — which on the screen he was looking at is the
 * same as not existing.
 *
 * Deliberately a CHECKLIST, not a nav row. A row of six links tells you where
 * things are; this tells you what state each one is in, which is the question
 * somebody actually has standing on a job: has the work order been written,
 * are submittals back, has anything been billed, is closeout started.
 *
 * Order follows the work, not the alphabet: submittals and the work order come
 * before anyone mobilises, change orders and billing run alongside, closeout
 * ends it.
 */

export type DeliveryTool = {
  key: string;
  label: string;
  href: string;
  /** Short state — "Not written", "2 open", "3 sent". */
  state: string;
  /** done = there and finished · active = in flight · todo = nothing yet. */
  status: "done" | "active" | "todo";
  /** Which delivery phase this belongs to. Karan 2026-08-13: "none of these
   *  say what phase they are correlated with." Without it the strip is six
   *  tools in a row and nothing tells you which ones are this week's. */
  phase: string;
};

// One color language across every delivery indicator (Karan 2026-08-15): green =
// done, AMBER = in progress/in flight, grey = not started. (active was blue here,
// out of step with the status bars + the Project spine.)
const DOT: Record<DeliveryTool["status"], string> = {
  done: "bg-emerald-500",
  active: "bg-amber-400",
  todo: "bg-ppp-charcoal-300",
};

export function DeliveryToolsStrip({
  tools,
  stageMeaning,
  fromTab,
}: {
  tools: DeliveryTool[];
  /** What the CURRENT stage means — the line that decides when to move on.
   *  A tooltip on the bar covers a mouse; this covers a phone, which is where
   *  Karan reads this. */
  stageMeaning?: string | null;
  /** The tab this strip is being shown on (overview/docs/activity). Stamped
   *  onto every tool link as `?from=` so the tool's back arrow returns HERE,
   *  not to the Project tool list. Karan 2026-08-14: opening a tool from
   *  Overview should come back to Overview. */
  fromTab?: string | null;
}) {
  if (tools.length === 0) return null;
  const withFrom = (href: string) =>
    fromTab ? `${href}${href.includes("?") ? "&" : "?"}from=${fromTab}` : href;
  return (
    <section
      aria-label="Delivery"
      className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden"
    >
      <div className="px-3.5 py-2 border-b border-ppp-charcoal-100 flex items-center justify-between gap-2">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
          Delivery
        </h2>
        <span className="text-[10.5px] text-ppp-charcoal-400">
          {tools.filter((t) => t.status === "todo").length} not started
        </span>
      </div>
      {/* ONE ROW, with the phase named once per group.
          Karan tried the stacked-blocks version and preferred this: "I like
          the other bar better." A row you scan left-to-right reads as a
          sequence, which is what delivery IS; stacking it into four bordered
          blocks turned a timeline into a form. The phase label still prints
          once per group, so the grouping is there without the furniture. */}
      <div className="flex items-stretch divide-x divide-ppp-charcoal-100 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {tools.map((t, i) => (
          <Link
            key={t.key}
            href={withFrom(t.href)}
            className="group min-w-[9rem] flex-1 px-3.5 py-2.5 min-h-[44px] hover:bg-cc-brand-50/50 transition-colors"
          >
            <span className="block text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-0.5 whitespace-nowrap">
              {i === 0 || tools[i - 1].phase !== t.phase ? t.phase : "\u00A0"}
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full shrink-0 ${DOT[t.status]}`} />
              <span className="text-[11.5px] font-semibold text-ppp-charcoal group-hover:text-cc-brand-800 whitespace-nowrap">
                {t.label}
              </span>
            </span>
            <span
              className={`block text-[11px] mt-0.5 whitespace-nowrap ${
                t.status === "todo" ? "text-ppp-charcoal-400 italic" : "text-ppp-charcoal-600"
              }`}
            >
              {t.state}
            </span>
          </Link>
        ))}
      </div>
      {stageMeaning && (
        <p className="px-3.5 py-2 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500">
          <span className="font-semibold text-ppp-charcoal-600">Where it is now:</span> {stageMeaning}
        </p>
      )}
    </section>
  );
}
