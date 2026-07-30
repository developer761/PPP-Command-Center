/**
 * Intercepted Change Orders — renders the real Change Orders page INSIDE the
 * right-hand drawer when navigated to from within the account (soft nav). A
 * hard nav / refresh skips the interceptor and renders the full page instead
 * (this slot falls back to default.tsx = null).
 *
 * We reuse the full page component so there's ONE source of truth for the tool
 * (data + server actions live there); the drawer is purely a container.
 */
import { ToolDrawer } from "@/components/commercial/tool-drawer";
import ChangeOrdersPage from "../../../change-orders/[dealId]/page";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<Record<string, string | undefined>>;

export default function InterceptedChangeOrders({ params, searchParams }: { params: PP; searchParams: SP }) {
  return (
    <ToolDrawer title="Change Orders">
      <ChangeOrdersPage params={params} searchParams={searchParams} />
    </ToolDrawer>
  );
}
