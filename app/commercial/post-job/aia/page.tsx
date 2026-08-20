/**
 * Retired — AIA Billing across every job.
 *
 * The 2026-08 restructure (§4.1) removed the six Post-Job entries from the
 * sidebar and replaced them with SAVED VIEWS on the opportunities list: "one
 * list, different saved filters". §4.2 required every retired route to redirect
 * to its new home, and this one never did — so it kept rendering a full index
 * that nothing in the navigation could reach, and that quietly disagreed with
 * the list it was replaced by.
 *
 * Redirecting rather than deleting: these URLs are in bookmarks, bell
 * notifications and sent email.
 *
 * → "billing" · Jobs at the billing stage, which is what AIA applications are.
 */
import { redirect } from "next/navigation";
import { savedViewHref } from "@/lib/commercial/opportunities/saved-views";

export default async function RetiredPostJobAia() {
  redirect(savedViewHref("billing"));
}
