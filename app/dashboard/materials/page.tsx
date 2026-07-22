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
  const props = await loadMaterialsViewProps(sp);

  // Legacy deep-link support: ?wo=<id> still pre-selects a WO. The canonical
  // path is now /dashboard/materials/[woId] (Kate #1), but existing links
  // (older emails, bookmarks) keep working via initialWoId.
  const rawWo = sp.wo;
  const initialWoId =
    typeof rawWo === "string" ? rawWo : Array.isArray(rawWo) ? rawWo[0] : null;

  return <MaterialsView {...props} initialWoId={initialWoId ?? null} />;
}
