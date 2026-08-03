import { redirect } from "next/navigation";

/** /commercial/reports → the first report (AR Aging). The tab bar switches
 *  between reports from there. */
export default function ReportsIndex() {
  redirect("/commercial/reports/ar-aging");
}
