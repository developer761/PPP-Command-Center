import Link from "next/link";
import type { DeliveryTool } from "./delivery-tools-strip";

/**
 * The Project HOME — the landing you get on `?tab=project` with no tool open.
 *
 * Karan 2026-08-14: *"build the Project home: tool cards with live status +
 * quick links."* Then, on the first cut: *"it looks so scrappy... so much blank
 * space."* — a 3-column grid stranded empty cells whenever a phase had one or
 * two tools. Rebuilt: within each phase the cards FLEX to fill the row (two
 * split it, a lone one takes the whole width — no empty cells), each is a
 * compact icon card with its live state, and the phases stack as a short
 * pre-construction → close-out sequence so you read the shape of the job in one
 * pass without a wall of white space.
 */

const ACCENT: Record<
  DeliveryTool["status"],
  { border: string; iconBg: string; iconText: string; dot: string; state: string }
> = {
  done: {
    border: "border-emerald-200 hover:border-emerald-300",
    iconBg: "bg-emerald-50",
    iconText: "text-emerald-600",
    dot: "bg-emerald-500",
    state: "text-emerald-700",
  },
  active: {
    border: "border-cc-brand-200 hover:border-cc-brand-300",
    iconBg: "bg-cc-brand-50",
    iconText: "text-cc-brand-600",
    dot: "bg-cc-brand-500",
    state: "text-ppp-charcoal-700",
  },
  todo: {
    border: "border-ppp-charcoal-100 hover:border-ppp-charcoal-200",
    iconBg: "bg-ppp-charcoal-50",
    iconText: "text-ppp-charcoal-400",
    dot: "bg-ppp-charcoal-300",
    state: "text-ppp-charcoal-400 italic",
  },
};

/** One recognisable glyph per delivery tool, so the row reads at a glance
 *  rather than as seven identical boxes. Unknown keys fall back to a doc. */
function ToolIcon({ toolKey }: { toolKey: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (toolKey) {
    case "submittals": // paper plane — sent to the GC
      return <svg {...common}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>;
    case "work-order": // clipboard
      return <svg {...common}><path d="M9 2h6a1 1 0 0 1 1 1v1h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zM9 4v1h6V4" /></svg>;
    case "change-orders": // edit
      return <svg {...common}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>;
    case "costs": // dollar
      return <svg {...common}><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>;
    case "aia": // layered application
      return <svg {...common}><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>;
    case "invoices": // receipt
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 13h6M9 17h6" /></svg>;
    case "closeout": // badge-check
      return <svg {...common}><path d="m9 12 2 2 4-4M12 2 4 5v6c0 5.5 3.8 8.9 8 10 4.2-1.1 8-4.5 8-10V5l-8-3z" /></svg>;
    default:
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6" /></svg>;
  }
}

export function ProjectHome({
  tools,
  stageMeaning,
}: {
  tools: DeliveryTool[];
  /** What the current stage means — the line that decides when to move on. */
  stageMeaning?: string | null;
}) {
  if (tools.length === 0) return null;

  // Group consecutive tools by phase — the array already arrives in work order.
  const groups: { phase: string; tools: DeliveryTool[] }[] = [];
  for (const t of tools) {
    const last = groups[groups.length - 1];
    if (last && last.phase === t.phase) last.tools.push(t);
    else groups.push({ phase: t.phase, tools: [t] });
  }

  const notStarted = tools.filter((t) => t.status === "todo").length;
  const done = tools.filter((t) => t.status === "done").length;

  return (
    <section aria-label="Project delivery" className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 px-4 py-2.5 border-b border-ppp-charcoal-100">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-600">
          Delivery
        </h2>
        <span className="text-[11px] text-ppp-charcoal-500 tabular-nums">
          {done} done · {notStarted} not started · {tools.length} tools
        </span>
      </header>

      <div className="p-3 space-y-3">
        {groups.map((g) => (
          <div key={g.phase}>
            <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1.5 px-0.5">
              {g.phase}
            </div>
            <div className="flex flex-wrap gap-2">
              {g.tools.map((t) => {
                const a = ACCENT[t.status];
                return (
                  <Link
                    key={t.key}
                    href={t.href}
                    className={`group flex-1 min-w-[220px] flex items-center gap-3 rounded-lg border bg-surface px-3 py-2.5 min-h-[44px] transition-all hover:shadow-sm ${a.border}`}
                  >
                    <span className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${a.iconBg} ${a.iconText}`}>
                      <ToolIcon toolKey={t.key} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-bold text-ppp-charcoal group-hover:text-cc-brand-800 truncate leading-tight">
                        {t.label}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full shrink-0 ${a.dot}`} />
                        <span className={`text-[11.5px] ${a.state} truncate`}>{t.state}</span>
                      </div>
                    </div>
                    <svg
                      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                      className="shrink-0 text-ppp-charcoal-300 group-hover:text-cc-brand-600 group-hover:translate-x-0.5 transition-all"
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {stageMeaning && (
        <p className="px-4 py-2.5 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/50 text-[11.5px] text-ppp-charcoal-600">
          <span className="font-semibold text-ppp-charcoal-700">Where it is now:</span> {stageMeaning}
        </p>
      )}
    </section>
  );
}
