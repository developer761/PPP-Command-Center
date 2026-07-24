/** Skeleton for the invoice detail page (hero + line items + payments). */
export default function InvoiceDetailLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-9 w-24 bg-white border border-ppp-charcoal-100 rounded-lg" />
      <div className="h-3 w-56 bg-white border border-ppp-charcoal-100 rounded" />
      <div className="h-40 bg-white border border-ppp-charcoal-100 rounded-xl" />
      <div className="h-48 bg-white border border-ppp-charcoal-100 rounded-xl" />
      <div className="h-40 bg-white border border-ppp-charcoal-100 rounded-xl" />
    </div>
  );
}
