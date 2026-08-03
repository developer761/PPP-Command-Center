import { redirect } from "next/navigation";

/** /commercial/reports → the first report (Pipeline). The tab bar switches
 *  between reports from there. */
export default function ReportsIndex() {
  redirect("/commercial/reports/pipeline");
}
