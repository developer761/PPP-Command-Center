import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getSpendRows, LABOR_PAYMENTS_SPEC, laborPaymentRows } from "@/lib/commercial/reports/tomco/transactions";
import { TomcoReportPage, viewIndex, periodFrom } from "@/components/commercial/tomco-report-page";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "payee", label: "By payee" },
  { key: "job", label: "By job" },
];

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string; period?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "labor-payments");

  const sp = await searchParams;
  const period = sp.period ?? "all";
  const from = periodFrom(period);
  // The window Tomco names the report after. `ymd` is already an ET
  // calendar day, so this is a string compare and cannot drift a day.
  const rows = laborPaymentRows(await getSpendRows()).filter((r) => !from || (r.ymd ?? "") >= from);

  return (
    <TomcoReportPage
      spec={LABOR_PAYMENTS_SPEC}
      rows={rows}
      href="/commercial/reports/labor-payments"
      view={viewIndex(VIEWS, sp.view)}
      views={VIEWS}
      period={period}
      emptyHint="No crew payments recorded yet."
    />
  );
}
