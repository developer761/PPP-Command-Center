import PageHeader from "@/components/page-header";

export const dynamic = "force-dynamic";

export default function MaterialsOrderingPage() {
  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      <PageHeader
        title="Materials Ordering"
        subtitle="Aggregate paint colors across upcoming work orders, group by supplier, generate orders"
      />

      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 sm:p-12">
        <div className="flex flex-col items-center text-center max-w-xl mx-auto">
          <div className="h-14 w-14 rounded-full bg-ppp-orange-50 text-ppp-orange-700 flex items-center justify-center text-2xl mb-4">
            🎨
          </div>
          <h2 className="text-lg font-bold text-ppp-navy">Phase 2 — Coming Soon</h2>
          <p className="text-sm text-ppp-charcoal-500 mt-2">
            This will be the day-to-day operational tool for the field team:
            see what paint to order from Benjamin Moore (and other suppliers),
            for what jobs, by when.
          </p>

          <div className="mt-6 w-full grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
            <Feature
              title="Color aggregation"
              body="Roll up paint colors across every upcoming Work Order Line Item — quantities, sheen, brand, all in one view."
            />
            <Feature
              title="Vendor-grouped"
              body="Benjamin Moore primary, with Sherwin Williams and other suppliers as separate tabs."
            />
            <Feature
              title="Printable order forms"
              body="One-click PDF order forms ready to email or hand to the supplier."
            />
            <Feature
              title="Status workflow"
              body="Pending → Ordered → Received → Installed. Auto-update when WO line items progress."
            />
          </div>

          <div className="mt-6 text-[11px] text-ppp-charcoal-500 italic">
            Blocked on confirming the Work_Order_Line_Item__c schema in production.
            Locked-in plan: <code>~/Desktop/PPP_Cutover_And_Phase2_Plan.md</code> §3
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/40 p-4">
      <div className="font-semibold text-ppp-charcoal text-sm">{title}</div>
      <div className="text-xs text-ppp-charcoal-500 mt-1">{body}</div>
    </div>
  );
}
