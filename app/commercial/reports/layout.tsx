import { ReportTabs } from "@/components/commercial/report-tabs";

/**
 * Reports framework shell (R4) — the shared report tab bar sits above every
 * /commercial/reports/* page so each report reads as a tab of one Reports area.
 * Kept minimal (just the tabs) so each report page owns its own content/width.
 */
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-6">
        <ReportTabs />
      </div>
      {children}
    </>
  );
}
