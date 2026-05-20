import DashboardView from "@/components/dashboard-view";
import { getReps } from "@/lib/data-source";

export default async function DashboardPage() {
  const { reps, source, reason } = await getReps();
  return <DashboardView reps={reps} dataSource={source} dataSourceReason={reason} />;
}
