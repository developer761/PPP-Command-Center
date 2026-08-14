import { deriveDeliverySpine } from "@/lib/commercial/projects/project-attention";

/**
 * The compact delivery glance — one line above the tab bar on the non-project
 * tabs, so on any surface you can see where the job is in delivery.
 *
 * Karan 2026-08-13→15: this started as a row of tool LINKS, but the tools are
 * already the deal's tab bar, so a link row was a second copy of the navigation
 * that "serves no purpose." It's now a compact PROGRESS SPINE — the same six
 * stages the Project tab shows, shrunk to a strip of dots with the current
 * stage named — which answers something the tabs can't: how far along is this.
 */

export type DeliveryTool = {
  key: string;
  label: string;
  href: string;
  /** Short state — "Not written", "2 open", "3 sent". */
  state: string;
  /** done = there and finished · active = in flight · todo = nothing yet. */
  status: "done" | "active" | "todo";
  /** Which delivery phase this belongs to. */
  phase: string;
};

const DOT: Record<"done" | "partial" | "todo", string> = {
  done: "bg-emerald-500",
  partial: "bg-amber-400",
  todo: "bg-ppp-charcoal-200",
};

export function DeliveryToolsStrip({
  status,
  tools,
  stageMeaning,
}: {
  status: string;
  tools: DeliveryTool[];
  /** What the CURRENT stage means — the line that decides when to move on. */
  stageMeaning?: string | null;
}) {
  if (tools.length === 0) return null;
  const byKey = (k: string) => {
    const t = tools.find((x) => x.key === k);
    return t ? { status: t.status, label: t.state } : null;
  };
  const spine = deriveDeliverySpine({
    status,
    wonLabel: null,
    onSite: false,
    submittals: byKey("submittals"),
    billing: byKey("invoices") ?? byKey("aia"),
    closeout: byKey("closeout"),
  });
  const current = spine.find((s) => s.current);
  const doneN = spine.filter((s) => s.state === "done").length;

  return (
    <section aria-label="Delivery progress" className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500 shrink-0">Delivery</span>
        <div className="flex items-center flex-1 min-w-0" aria-hidden>
          {spine.map((s, i) => (
            <div key={s.key} className="flex items-center flex-1 min-w-0 last:flex-none">
              <span className={`h-2 w-2 rounded-full shrink-0 ${DOT[s.state]} ${s.current ? "ring-2 ring-cc-brand-500/30" : ""}`} title={`${s.label}${s.meta ? ` — ${s.meta}` : ""}`} />
              {i < spine.length - 1 && (
                <span className={`h-[2px] flex-1 mx-0.5 ${s.state === "done" ? "bg-emerald-400" : "bg-ppp-charcoal-100"}`} />
              )}
            </div>
          ))}
        </div>
        <span className="text-[11px] font-semibold text-ppp-charcoal-600 shrink-0 tabular-nums">
          {current ? current.label : `${doneN}/${spine.length}`}
        </span>
      </div>
      {stageMeaning && (
        <p className="px-3.5 py-2 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500">
          <span className="font-semibold text-ppp-charcoal-600">Where it is now:</span> {stageMeaning}
        </p>
      )}
    </section>
  );
}
