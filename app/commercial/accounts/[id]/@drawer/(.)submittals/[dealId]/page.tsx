/**
 * Intercepted Submittals — renders the real Submittals log inside the drawer on
 * same-level nav from the account; hard nav / index → full page. (Drilling into
 * a specific submittal navigates to the full [sid] page — a deeper segment the
 * list interceptor doesn't cover.)
 */
import { ToolDrawer } from "@/components/commercial/tool-drawer";
import SubmittalsPage from "../../../submittals/[dealId]/page";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<Record<string, string | undefined>>;

export default function InterceptedSubmittals({ params, searchParams }: { params: PP; searchParams: SP }) {
  return (
    <ToolDrawer title="Submittals">
      <SubmittalsPage params={params} searchParams={searchParams} />
    </ToolDrawer>
  );
}
