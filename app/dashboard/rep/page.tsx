import Link from "next/link";
import PageHeader from "@/components/page-header";
import { getReps } from "@/lib/data-source";

export default async function RepIndexPage() {
  const { reps, source, reason } = await getReps();

  // Compute team total once (used for "% of team revenue" pill).
  const teamTotal = reps.reduce((s, r) => s + r.revenueSold, 0);

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      <PageHeader
        title="Rep Profiles"
        subtitle={
          source === "salesforce"
            ? `${reps.length} active rep${reps.length === 1 ? "" : "s"} from Salesforce. Pick one to view their full analytics.`
            : reason === "sf_not_connected"
            ? "Salesforce isn't connected yet — showing demo data. Connect SF in Admin → Integrations to see real PPP reps."
            : reason === "sf_returned_empty"
            ? "Salesforce returned no reps — showing demo data. The sandbox may be empty; ask Katie to populate it or switch to production."
            : "Pick a rep to view their full analytics — multi-month revenue trend, close rate, avg ticket, recent deals"
        }
      />

      {source === "mock" && reason && reason !== "sf_not_connected" && (
        <div className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700 text-xs sm:text-sm px-4 py-3">
          <strong>Live data unavailable:</strong> {reason}. Falling back to demo data so the dashboard still renders.
        </div>
      )}

      {reps.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">No reps to show</p>
          <p className="text-xs text-ppp-charcoal-500 mt-1">
            Connect Salesforce in Admin → Integrations to populate this view.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {[...reps]
            .sort((a, b) => b.revenueSold - a.revenueSold)
            .map((r) => {
              const teamShare = teamTotal > 0 ? Math.round((r.revenueSold / teamTotal) * 100) : 0;
              return (
                <Link
                  key={r.id}
                  href={`/dashboard/rep/${r.id}`}
                  className="group bg-white border border-ppp-charcoal-100 rounded-xl p-5 hover:border-ppp-blue-200 hover:shadow-md hover:shadow-ppp-charcoal/5 transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-11 w-11 rounded-full bg-ppp-blue-50 text-ppp-blue text-sm font-bold flex items-center justify-center">
                      {r.name.split(" ").map((n) => n[0]).join("")}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-ppp-charcoal group-hover:text-ppp-blue transition-colors truncate">
                        {r.name}
                      </div>
                      <div className="text-[11px] text-ppp-charcoal-500 truncate">
                        {r.region} · {r.serviceLine}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="font-condensed text-base font-bold text-ppp-navy">
                        ${r.revenueSold}K
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                        Revenue
                      </div>
                    </div>
                    <div>
                      <div className="font-condensed text-base font-bold text-ppp-navy">
                        {r.closeRate.toFixed(1)}%
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                        Close
                      </div>
                    </div>
                    <div>
                      <div className="font-condensed text-base font-bold text-ppp-navy">
                        ${r.avgTicket.toFixed(1)}K
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                        Ticket
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-ppp-charcoal-100 flex items-center justify-between">
                    <span className="text-[11px] text-ppp-charcoal-500">
                      {teamShare}% of team revenue
                    </span>
                    <span className="text-[11px] font-medium text-ppp-blue opacity-0 group-hover:opacity-100 transition-opacity">
                      Open profile →
                    </span>
                  </div>
                </Link>
              );
            })}
        </div>
      )}
    </div>
  );
}
