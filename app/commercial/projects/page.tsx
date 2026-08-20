/**
 * Retired — the cross-account Projects list.
 *
 * Removed from the sidebar by the 2026-08 restructure (§4.1) alongside
 * Proposals, Invoices and the six Post-Job entries, and replaced by the "In
 * production" saved view on the opportunities list. §4.2 required the route to
 * redirect; it never did, so it kept rendering a second, slightly different
 * answer to the same question.
 *
 * Redirecting rather than deleting — the URL is in bookmarks and old links.
 */
import { redirect } from "next/navigation";
import { savedViewHref } from "@/lib/commercial/opportunities/saved-views";

export default async function RetiredProjectsIndex() {
  redirect(savedViewHref("active_projects"));
}
