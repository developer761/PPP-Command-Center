import { redirect } from "next/navigation";

/** Field Ops landing -> the Overview tab (KPIs + what needs attention). */
export default function FieldOpsHubPage() {
  redirect("/commercial/field-ops/overview");
}
