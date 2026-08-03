import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { BidSubmitForm } from "@/components/commercial/bid-submit-form";

/**
 * Public online bid form (R6) — no auth. A GC submits an RFP here; it becomes a
 * "web" opportunity + notifies the team. Branded with the operating company
 * (Tomco) identity. Lives at /c/bid-submit (outside the authed /commercial shell).
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Submit a bid request",
  robots: { index: false }, // a lead-intake form, not a page to index
};

export default async function BidSubmitPage() {
  const oc = await getOperatingCompany();
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || undefined;

  return (
    <main className="min-h-screen bg-ppp-charcoal-50/40 py-8 px-4 sm:py-12">
      <div className="max-w-xl mx-auto">
        <header className="text-center mb-6">
          <div className="font-condensed text-xl font-black tracking-tight text-ppp-navy-700 uppercase">{oc.name}</div>
          <span aria-hidden className="block mx-auto mt-3 h-1 w-12 rounded-full bg-cc-brand-600" />
        </header>

        <div className="bg-surface border border-ppp-charcoal-100 rounded-2xl shadow-sm p-5 sm:p-7">
          <div className="mb-5">
            <h1 className="text-xl sm:text-2xl font-bold text-ppp-charcoal">Submit a bid request</h1>
            <p className="text-[13.5px] text-ppp-charcoal-500 mt-1">
              Tell us about the project and we&rsquo;ll get you a proposal. Fields marked * are required.
            </p>
          </div>
          <BidSubmitForm turnstileSiteKey={siteKey} />
        </div>

        <footer className="text-center mt-6 text-[12px] text-ppp-charcoal-400">
          {[oc.name, oc.phone, oc.website].filter(Boolean).join(" · ")}
        </footer>
      </div>
    </main>
  );
}
