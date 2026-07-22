import { redirect } from "next/navigation";
import MaterialsView from "@/components/materials-view";
import { loadMaterialsViewProps } from "@/lib/materials/view-props";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MaterialsOrderingPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;

  // Legacy deep-link: ?wo=<id> used to pre-select the WO in the old right
  // panel. Now that each WO has its own page (Kate #1) and the list page has
  // no panel, forward old links (emails, bookmarks) to the canonical route so
  // they actually open the work order instead of silently no-op'ing.
  const rawWo = sp.wo;
  const legacyWo =
    typeof rawWo === "string" ? rawWo : Array.isArray(rawWo) ? rawWo[0] : null;
  if (legacyWo && legacyWo.trim()) {
    redirect(`/dashboard/materials/${encodeURIComponent(legacyWo.trim())}`);
  }

  const props = await loadMaterialsViewProps(sp);
  return <MaterialsView {...props} initialWoId={null} />;
}
