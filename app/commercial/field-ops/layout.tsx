import { FieldOpsTabs } from "@/components/commercial/field-ops-tabs";

/**
 * R10 Field Ops layout - a tab bar (Week Grid / Calendar / Job Board / Work
 * Orders / Crew) sits above every field-ops surface. The tab bar is hidden on
 * the bare hub route via the page itself redirecting to the first tab.
 */
export default function FieldOpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-6">
      <FieldOpsTabs />
      {children}
    </div>
  );
}
