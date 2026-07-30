/**
 * Intercepted Closeout & Warranty — renders the real Closeout page inside the
 * drawer on same-level nav from the account; hard nav / index → full page.
 */
import { ToolDrawer } from "@/components/commercial/tool-drawer";
import CloseoutPage from "../../../closeout/[dealId]/page";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<Record<string, string | undefined>>;

export default function InterceptedCloseout({ params, searchParams }: { params: PP; searchParams: SP }) {
  return (
    <ToolDrawer title="Closeout & Warranty">
      <CloseoutPage params={params} searchParams={searchParams} />
    </ToolDrawer>
  );
}
