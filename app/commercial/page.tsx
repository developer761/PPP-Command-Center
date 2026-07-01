/**
 * `/commercial` — Commercial Command Center landing.
 *
 * Evolves into the executive dashboard (sales / ops / financial / workforce
 * / scorecard per the diagram) as phases ship. For now: roadmap card so
 * Alex + Katie can see what's shipped vs queued at a glance.
 */
export const dynamic = "force-dynamic";

// Roadmap statuses. Keep in sync with what's actually been merged on main.
// "Shipped" = live in prod; "Up next" = the next phase being scoped/built;
// "Queued" = on the roadmap, not yet scoped.
const PHASES = [
  { num: 1, name: "Account Management", status: "Shipped", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { num: 2, name: "Opportunity (Preconstruction)", status: "Shipped", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { num: "2.5", name: "Submittals & Finish Schedule", status: "Shipped", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { num: 3, name: "Invoicing & Revenue", status: "Up next", color: "bg-blue-50 text-blue-700 border-blue-200" },
  { num: 4, name: "Contract Award", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
  { num: 5, name: "Project Setup", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
  { num: 6, name: "Project Execution", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
  { num: 7, name: "Change Management", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
  { num: 9, name: "Closeout", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
];

export default function CommercialDashboardPage() {
  return (
    <div className="space-y-8">
      <header className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-cc-brand-800 via-cc-brand-700 to-cc-brand-800 text-white px-6 sm:px-8 py-8 sm:py-10 shadow-lg shadow-cc-brand-900/20">
        {/* Subtle diagonal texture — pure CSS, no image weight. */}
        <div aria-hidden className="absolute inset-0 opacity-[0.08]" style={{
          backgroundImage: "repeating-linear-gradient(135deg, transparent 0 12px, white 12px 13px)",
        }} />
        <div className="relative">
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-white bg-white/20 backdrop-blur-sm border border-white/30 px-2 py-0.5 rounded">
              Phase 3 · Invoicing Up Next
            </span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Commercial Command Center</h1>
          <p className="mt-1 text-sm text-cc-brand-100">
            From bid intake to closeout, all in one record.
          </p>
        </div>
      </header>

      <section className="bg-white rounded-xl border border-ppp-charcoal-100 p-6">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-1">Where we are</h2>
        <p className="text-sm text-ppp-charcoal-500 leading-relaxed">
          Phases 1–2.5 live: Account Management, Opportunities (Pipeline + Kanban + Win/Loss
          Debrief), and Submittals + Finish Schedule. Phase 3 — Invoicing &amp; Revenue
          dashboard — is up next. Each phase ships as its own slice with schema, surfaces,
          and edge-case audit before the next one starts.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Build roadmap</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {PHASES.map((p) => (
            <div key={String(p.num)} className="rounded-xl border border-ppp-charcoal-100 bg-white p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="inline-flex items-center justify-center h-7 min-w-[28px] px-2 rounded-full bg-ppp-charcoal text-white text-xs font-bold">
                  {p.num}
                </span>
                <span className={`text-[10px] font-bold tracking-widest uppercase border px-2 py-0.5 rounded ${p.color}`}>
                  {p.status}
                </span>
              </div>
              <div className="text-sm font-semibold text-ppp-charcoal">{p.name}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
