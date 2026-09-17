import { surfaceSteps, extraControls, type Surface, type Strip, type Control } from "@/lib/commercial/guide/walkthrough";
import { TourButton } from "@/components/commercial/guide-tour-button";

/**
 * One surface in the walkthrough: what the page is for, where it sits, the
 * steps, and what every control on it does.
 *
 * The control TABLE is the part that makes this a walkthrough rather than a
 * tour. "Go to Receivables and record the payment" is useless to somebody who
 * is already on Receivables and cannot tell which of nine controls to press —
 * so each one is listed by the exact words printed on it.
 */

const KIND_LABEL: Record<NonNullable<Control["kind"]>, string> = {
  button: "Button",
  field: "Field",
  filter: "Filter",
  link: "Link",
};

/** The tab strip, drawn, with the one you want picked out. */
export function TabStrip({ strip }: { strip: Strip }) {
  return (
    <div className="mb-3">
      <div className="flex overflow-x-auto rounded-lg border border-ppp-charcoal-200 bg-ppp-charcoal-50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {strip.boxes.map((b, i) => (
          <span
            key={b}
            className={`shrink-0 px-3 py-1.5 text-[11.5px] whitespace-nowrap ${
              i === strip.at
                ? "font-bold text-ppp-charcoal bg-surface border-b-2 border-cc-brand-600"
                : "text-ppp-charcoal-500"
            }`}
          >
            {b}
          </span>
        ))}
      </div>
      {/* No marker row underneath.
          There was one — a rotated square per tab, positioned with flex-1 — and
          it could not line up: the strip scrolls sideways with shrink-0 tabs of
          their natural width, so a parallel row of equal-width cells drifts
          further off with every tab, and further still once the strip is
          scrolled. The bold text and the orange rule under the live tab already
          say which one it is. */}
    </div>
  );
}

export function SurfaceCard({ surface }: { surface: Surface }) {
  // The steps already name every field they walk you through; repeating them
  // in the table below doubles the card for no new information.
  const extras = extraControls(surface);
  return (
    <article className="rounded-xl border border-ppp-charcoal-100 bg-surface p-4 sm:p-5 space-y-0.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[17px] font-bold text-ppp-charcoal leading-tight tracking-tight">{surface.name}</h3>
          <p className="text-[11.5px] font-semibold text-cc-brand-700 mt-0.5">{surface.path}</p>
        </div>
        {/* "Try it out", not "Open it": dropping somebody on the real page with
            no guidance is the situation the guide exists to fix. This walks them
            through it with the app held non-interactive underneath. */}
        <TourButton steps={surfaceSteps(surface)} label={surface.name}>
          Try it out
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14 M13 5l7 7-7 7" />
          </svg>
        </TourButton>
      </div>

      <p className="text-[13px] text-ppp-charcoal-600 leading-relaxed mt-2.5">{surface.purpose}</p>

      {surface.strip && (
        <div className="mt-4">
          <TabStrip strip={surface.strip} />
        </div>
      )}

      {surface.steps && surface.steps.length > 0 && (
        <ol className="mt-4 space-y-2.5">
          {surface.steps.map((st, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="mt-[2px] shrink-0 inline-flex items-center justify-center h-[20px] w-[20px] rounded-full bg-ppp-charcoal text-white text-[10.5px] font-bold tabular-nums">
                {i + 1}
              </span>
              <span className="text-[13.5px] text-ppp-charcoal leading-relaxed">{st}</span>
            </li>
          ))}
        </ol>
      )}

      {extras.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-2">
            Also on this page
          </h4>
          <ul className="border-l border-ppp-charcoal-100 pl-3 space-y-1.5">
            {extras.map((c) => (
              <li key={c.label} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3">
                <span className="sm:w-[32%] shrink-0 text-[12.5px] font-bold text-ppp-charcoal">
                  {c.label}
                  {c.kind && c.kind !== "button" && (
                    <span className="ml-1.5 text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                      {KIND_LABEL[c.kind]}
                    </span>
                  )}
                  {c.required && (
                    <span className="ml-1.5 text-[9.5px] font-bold uppercase tracking-wider text-cc-brand-700">
                      Required
                    </span>
                  )}
                </span>
                <span className="flex-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">{c.does}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {surface.watchOut && (
        <div className="mt-4 rounded-lg border-l-[3px] border-cc-brand-600 bg-cc-brand-50 px-3 py-2.5">
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-cc-brand-700 mb-0.5">Watch out</p>
          <p className="text-[12.5px] text-cc-brand-900 leading-relaxed">{surface.watchOut}</p>
        </div>
      )}
    </article>
  );
}
