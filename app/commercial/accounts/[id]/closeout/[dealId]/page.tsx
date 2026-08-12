/**
 * Redirect — this tool lives on the opportunity now.
 *
 * Restructure step 3 (Karan 2026-08-12): the opportunity is the home of the
 * whole job, so the delivery tools render there rather than on account-scoped
 * routes. The tool BODY (`closeout-tool.tsx`) is unchanged and still lives
 * here — it is imported by the opportunity page and by the account page's deal
 * drill-in. Only this route wrapper is retired.
 *
 * Kept as a redirect rather than deleted: these URLs are in bookmarks, bell
 * notifications and sent emails. Query params carry through so a deep link to
 * a specific record still lands on it.
 *
 * See docs/RESTRUCTURE_OPP_PROJECT_2026_08.md §4.2.
 */
import { redirect } from "next/navigation";

export default async function RedirectToOpportunity({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; dealId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { dealId } = await params;
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "project", sub: "closeout" });
  for (const [k, v] of Object.entries(sp)) {
    if (k === "tab" || k === "sub") continue;
    const first = Array.isArray(v) ? v[0] : v;
    if (first != null) q.set(k, first);
  }
  redirect(`/commercial/opportunities/${dealId}?${q.toString()}`);
}
