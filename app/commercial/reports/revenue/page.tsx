/**
 * Revenue & P&L moved onto the Dashboard (Karan 2026-08 — one command-center
 * view for the whole platform, like the residential PPP dashboard). This route
 * is kept only so old links/bookmarks land on the Dashboard instead of a 404.
 */
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function RevenueReportRedirect() {
  redirect("/commercial");
}
