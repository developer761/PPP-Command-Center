import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getMoneyInRows, DEPOSIT_HISTORY_SPEC } from "@/lib/commercial/reports/tomco/transactions";
import { TomcoReportPage, viewIndex, periodFrom } from "@/components/commercial/tomco-report-page";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "date", label: "By date" },
  { key: "gc", label: "By GC" },
  { key: "method", label: "By method" },
];

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string; period?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "deposit-history");

  const sp = await searchParams;
  const period = sp.period ?? "all";
  const from = periodFrom(period);
  // The window Tomco names the report after. `ymd` is already an ET
  // calendar day, so this is a string compare and cannot drift a day.
  const rows = (await getMoneyInRows()).filter((r) => !from || (r.ymd ?? "") >= from);

  return (
    <TomcoReportPage
      spec={DEPOSIT_HISTORY_SPEC}
      rows={rows}
      href="/commercial/reports/deposit-history"
      view={viewIndex(VIEWS, sp.view)}
      views={VIEWS}
      period={period}
      emptyHint="No payments in yet."
    />
  );
}
