import { redirect } from "next/navigation";

/**
 * R10.7 - the Week Grid is retired; the interactive Calendar is the one
 * scheduling surface. Old links (incl. ?week=) fold onto the calendar month.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}-\d{2}$/.test(sp.week ?? "") ? `?month=${sp.week}` : "";
  redirect(`/commercial/field-ops/calendar${month}`);
}
