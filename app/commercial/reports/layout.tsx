import { cookies } from "next/headers";
import { ReportTabs, type TabFolder, type TabReport } from "@/components/commercial/report-tabs";
import { createClient } from "@/lib/supabase/server";
import { getReportAccess, getViewerFolders } from "@/lib/commercial/reports/access";
import { FOLDER_COOKIE, folderReports } from "@/lib/commercial/reports/access-rule";
import { reportDef } from "@/lib/commercial/reports/registry";

/**
 * Reports framework shell — the shared tab bar above every
 * /commercial/reports/* page.
 *
 * NOT an access gate. A layout doesn't re-render when you move between the
 * reports under it, and it never runs for server actions, so each report page
 * (and each action) checks folder access itself via requireReportAccess. This
 * only decides which tabs to draw: the reports this viewer may open, plus their
 * folders so the bar can scope itself to the folder they came from.
 */
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let reports: TabReport[] = [];
  let folders: TabFolder[] = [];
  let initialFolder: string | null = null;
  if (user) {
    const access = await getReportAccess(user.id, user.email);
    reports = access.visibleList.map((k) => {
      const d = reportDef(k);
      return { key: k, href: d.href, label: d.tabLabel };
    });
    const list = await getViewerFolders(user.id, access.isAdmin);
    if (list.ok) {
      folders = [...list.shared, ...list.personal].map((f) => ({
        id: f.id,
        name: f.name,
        keys: folderReports(
          f.id,
          f.reportKeys.map((k, i) => ({ folder_id: f.id, report_key: k, sort_order: i })),
          access.visible
        ),
      }));
    }
    initialFolder = (await cookies()).get(FOLDER_COOKIE)?.value ?? null;
  }

  return (
    <>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-6">
        <ReportTabs reports={reports} folders={folders} initialFolder={initialFolder} />
      </div>
      {children}
    </>
  );
}
