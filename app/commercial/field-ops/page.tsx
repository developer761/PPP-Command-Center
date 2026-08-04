import { redirect } from "next/navigation";

/** Field Ops landing -> the Week Grid tab (the tabs handle navigation). */
export default function FieldOpsHubPage() {
  redirect("/commercial/field-ops/schedule");
}
