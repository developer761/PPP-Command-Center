import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getSpendRows, REIMBURSEMENTS_SPEC, reimbursementRows } from "@/lib/commercial/reports/tomco/transactions";
import { TomcoReportPage, viewIndex, periodFrom } from "@/components/commercial/tomco-report-page";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "to", label: "By person" },
  { key: "job", label: "By job" },
];

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string; period?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "reimbursements-out");

  const sp = await searchParams;
  const period = sp.period ?? "all";
  const from = periodFrom(period);
  // The window Tomco names the report after. `ymd` is already an ET
  // calendar day, so this is a string compare and cannot drift a day.
  const rows = reimbursementRows(await getSpendRows()).filter((r) => !from || (r.ymd ?? "") >= from);

  return (
    <TomcoReportPage
      spec={REIMBURSEMENTS_SPEC}
      rows={rows}
      href="/commercial/reports/reimbursements-out"
      view={viewIndex(VIEWS, sp.view)}
      views={VIEWS}
      period={period}
      emptyHint="Nothing has been reimbursed."
    />
  );
}
