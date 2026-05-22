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
          <h2 className="text-lg font-bold text-ppp-navy">Phase 2 — In Build</h2>
          <p className="text-sm text-ppp-charcoal-500 mt-2">
            Schema verified 2026-05-22: WorkOrderLineItem (standard SF FSL object,
            163k records on production), 5 paint-color slots per line item
            (Wall / Ceiling / Trim / Floor / Other), all linking to PaintColor__c.
            UI build kicking off next session.
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
              title="Side-by-side review"
              body="Draft email + supplier context shown side by side. Always reviewed before send — zero auto-send."
            />
            <Feature
              title="Status workflow"
              body="Draft → Reviewed → Sent → Received → Installed. Audit trail at every step."
            />
          </div>

          <div className="mt-6 text-[11px] text-ppp-charcoal-500 italic">
            Open questions for Katie: BM ordering mechanism (email/PDF/API?),
            approval workflow, min-order threshold, PaintColor__c brand/supplier field.
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
