import Link from "next/link";
import PageHeader from "@/components/page-header";
import { reps, teamTotals } from "@/lib/mock-data";

export default function RepIndexPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Rep Profiles"
        subtitle="Pick a rep to view their full analytics — multi-month revenue trend, close rate, avg ticket, recent deals"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...reps]
          .sort((a, b) => b.revenueSold - a.revenueSold)
          .map((r) => {
            const teamShare = Math.round((r.revenueSold / teamTotals.revenueSold) * 100);
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
                    <div className="text-base font-bold text-ppp-charcoal">
                      ${r.revenueSold}K
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                      Revenue
                    </div>
                  </div>
                  <div>
                    <div className="text-base font-bold text-ppp-charcoal">
                      {r.closeRate.toFixed(1)}%
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                      Close
                    </div>
                  </div>
                  <div>
                    <div className="text-base font-bold text-ppp-charcoal">
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
    </div>
  );
}
