import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getSalesTaxReport } from "@/lib/commercial/reports/sales-tax";
import { SALES_TAX_SPEC, taxedRows } from "@/lib/commercial/reports/tomco/sales-tax-spec";
import { TomcoReportPage, viewIndex, periodFrom } from "@/components/commercial/tomco-report-page";
import { formatCentsFull } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "rate", label: "By tax rate" },
  { key: "gc", label: "By GC" },
  { key: "month", label: "By month" },
];

export default async function SalesTaxReportPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; period?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "sales-tax");

  const sp = await searchParams;
  const period = sp.period ?? "all";
  const from = periodFrom(period);
  const report = await getSalesTaxReport();
  const rows = taxedRows(report.rows).filter((r) => !from || r.issuedYmd >= from);
  // Invoices that carried NO tax are not on the table above — they are not part
  // of a filing — but they are the thing a preparer gets asked about, so the
  // count and the base are stated rather than silently dropped.
  const zeroTax = report.rows.filter((r) => r.taxCents <= 0 && (!from || r.issuedYmd >= from));

  return (
    <TomcoReportPage
      spec={SALES_TAX_SPEC}
      rows={rows}
      href="/commercial/reports/sales-tax"
      view={viewIndex(VIEWS, sp.view)}
      views={VIEWS}
      period={period}
      emptyHint="No invoice in this window carried sales tax."
      footer={
        zeroTax.length > 0 ? (
          <p className="text-[12px] text-ppp-charcoal-500 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50 px-3 py-2">
            <strong className="text-ppp-charcoal">{zeroTax.length}</strong> further invoice
            {zeroTax.length === 1 ? "" : "s"} in this window carried no tax at all
            ({formatCentsFull(zeroTax.reduce((n, r) => n + r.subtotalCents, 0))} of work) and are not part of a filing.
            {report.unmarkedMigratedCount > 0 && (
              <> {report.unmarkedMigratedCount} of those came across from Salesforce, where the exemption is recorded.</>
            )}{" "}
            The Accounting page lists them with the reason for each.
          </p>
        ) : null
      }
    />
  );
}
