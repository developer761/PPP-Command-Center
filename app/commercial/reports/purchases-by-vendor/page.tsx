import { redirect } from "next/navigation";
import Link from "next/link";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getSpendRows, PURCHASES_BY_VENDOR_SPEC, purchaseRows, vendorOptions } from "@/lib/commercial/reports/tomco/transactions";
import { GroupedReport } from "@/components/commercial/grouped-report";
import { viewIndex } from "@/components/commercial/tomco-report-page";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "vendor", label: "By vendor" },
  { key: "job", label: "By job" },
  { key: "month", label: "By month" },
];

export default async function PurchasesByVendorPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; vendor?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "purchases-by-vendor");

  const sp = await searchParams;
  const all = purchaseRows(await getSpendRows());
  const vendors = vendorOptions(all);
  const vendor = sp.vendor && vendors.some((v) => v.name === sp.vendor) ? sp.vendor : undefined;
  const rows = vendor ? all.filter((r) => r.vendor === vendor) : all;
  const base = "/commercial/reports/purchases-by-vendor";
  const q = (v?: string, view?: string) =>
    `${base}?${new URLSearchParams({ ...(view ? { view } : {}), ...(v ? { vendor: v } : {}) }).toString()}`;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-400">{PURCHASES_BY_VENDOR_SPEC.sourceLabel}</p>
        <h2 className="text-lg font-bold text-ppp-charcoal leading-tight">
          {vendor ? `${vendor} — transactions` : PURCHASES_BY_VENDOR_SPEC.title}
        </h2>
        <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 max-w-2xl">{PURCHASES_BY_VENDOR_SPEC.blurb}</p>
      </div>

      <GroupedReport
        spec={PURCHASES_BY_VENDOR_SPEC}
        rows={rows}
        groupingIndex={viewIndex(VIEWS, sp.view)}
        emptyHint="No purchases match. Clear the vendor filter to see them all."
        controls={
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">Group by</span>
              {VIEWS.map((v, i) => (
                <Link
                  key={v.key}
                  href={q(vendor, v.key)}
                  aria-current={i === viewIndex(VIEWS, sp.view) ? "true" : undefined}
                  className={`px-2.5 rounded-lg border text-[12px] font-semibold min-h-[36px] inline-flex items-center ${
                    i === viewIndex(VIEWS, sp.view)
                      ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                      : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                  }`}
                >
                  {v.label}
                </Link>
              ))}
            </div>
            {/* One vendor's statement is the report Mary calls "Aboffs
                Transactions" — the same report with a vendor picked, rather
                than a second report per supplier. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">Vendor</span>
              <Link
                href={q(undefined, sp.view)}
                className={`px-2.5 rounded-lg border text-[12px] font-semibold min-h-[36px] inline-flex items-center ${
                  !vendor ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800" : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                }`}
              >
                All
              </Link>
              {vendors.slice(0, 12).map((v) => (
                <Link
                  key={v.name}
                  href={q(v.name, sp.view)}
                  className={`px-2.5 rounded-lg border text-[12px] font-semibold min-h-[36px] inline-flex items-center ${
                    vendor === v.name
                      ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                      : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                  }`}
                >
                  {v.name}
                  <span className="ml-1.5 text-ppp-charcoal-400 tabular-nums">{formatCentsCompact(v.cents)}</span>
                </Link>
              ))}
              {vendors.length > 12 && (
                <span className="text-[11.5px] text-ppp-charcoal-400">+{vendors.length - 12} more &mdash; group by vendor to see them all</span>
              )}
            </div>
          </div>
        }
      />
    </div>
  );
}
