/**
 * `/commercial` — New Platform landing.
 *
 * Phase 0 placeholder. As phases ship, this page evolves into the
 * executive dashboard (sales / operations / financial / workforce /
 * scorecard per the diagram). For now it just confirms the chrome works
 * and previews what's coming.
 */
export const dynamic = "force-dynamic";

const PHASES = [
  { num: 1, name: "Account Management", status: "Next up", color: "bg-blue-50 text-blue-700 border-blue-200" },
  { num: 2, name: "Opportunity (Preconstruction)", status: "Queued", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { num: 3, name: "Estimating & Proposal", status: "Queued", color: "bg-purple-50 text-purple-700 border-purple-200" },
  { num: 4, name: "Contract Award", status: "Queued", color: "bg-amber-50 text-amber-700 border-amber-200" },
  { num: 5, name: "Project Setup", status: "Queued", color: "bg-teal-50 text-teal-700 border-teal-200" },
  { num: 8, name: "Billing & Financials", status: "Pulled up", color: "bg-rose-50 text-rose-700 border-rose-200" },
  { num: 6, name: "Project Execution", status: "Heaviest phase", color: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  { num: 7, name: "Change Management", status: "Queued", color: "bg-red-50 text-red-700 border-red-200" },
  { num: 9, name: "Closeout", status: "Queued", color: "bg-yellow-50 text-yellow-700 border-yellow-200" },
];

export default function CommercialDashboardPage() {
  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
            Phase 0 · Foundation Live
          </span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal">New Platform</h1>
        <p className="mt-1 text-sm text-ppp-charcoal-500">
          Commercial Operating System — from bid intake to closeout, all in one record.
        </p>
      </header>

      <section className="bg-white rounded-xl border border-ppp-charcoal-100 p-6">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-1">Where we are</h2>
        <p className="text-sm text-ppp-charcoal-500 leading-relaxed">
          Phase 0 (this page, the platform picker, the sidebar switcher, RBAC, audit log) is live. Phase 1 — Account
          Management — is next. Each phase ships as its own slice with schema, surfaces, and edge-case audit before
          the next one starts. Plan doc: <code className="bg-ppp-charcoal-50 px-1.5 py-0.5 rounded text-xs">docs/NEW_PLATFORM_PLAN.md</code>.
          Architecture diagram for Alex: <code className="bg-ppp-charcoal-50 px-1.5 py-0.5 rounded text-xs">docs/NEW_PLATFORM_ARCHITECTURE.html</code>.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Build roadmap</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {PHASES.map((p) => (
            <div key={p.num} className="rounded-xl border border-ppp-charcoal-100 bg-white p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-ppp-charcoal text-white text-xs font-bold">
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
