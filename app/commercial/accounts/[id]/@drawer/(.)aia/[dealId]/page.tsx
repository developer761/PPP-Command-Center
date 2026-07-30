/**
 * Intercepted AIA Billing — renders the real AIA page inside the right-hand
 * drawer on same-level nav from the account; hard nav / index → full page.
 */
import { ToolDrawer } from "@/components/commercial/tool-drawer";
import AiaPage from "../../../aia/[dealId]/page";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<Record<string, string | undefined>>;

export default function InterceptedAia({ params, searchParams }: { params: PP; searchParams: SP }) {
  return (
    <ToolDrawer title="AIA Billing">
      <AiaPage params={params} searchParams={searchParams} />
    </ToolDrawer>
  );
}
