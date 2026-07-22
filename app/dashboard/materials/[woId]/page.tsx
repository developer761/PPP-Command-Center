import MaterialsView from "@/components/materials-view";
import { loadMaterialsViewProps } from "@/lib/materials/view-props";

export const dynamic = "force-dynamic";

/**
 * Single work order on its own page (Kate #1). Reuses the same data + the same
 * <MaterialsView> as the browse list, in "focus mode" — showing only this WO's
 * detail full-width with a Back link. The [woId] param is the Salesforce WO Id
 * (18-char preferred; a 15-char classic Id also resolves, #8). This is the
 * canonical deep-link target for the SF "Open in Command Center" button, the
 * mail timeline, the activity feed, and global search.
 */
export default async function MaterialsWorkOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ woId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ woId }, sp] = await Promise.all([params, searchParams]);
  // Trim + strip stray quotes a pasted SF Id sometimes carries.
  const cleanWoId = decodeURIComponent(woId).trim().replace(/^['"]|['"]$/g, "");
  const props = await loadMaterialsViewProps(sp);

  return <MaterialsView {...props} focusWoId={cleanWoId} />;
}
