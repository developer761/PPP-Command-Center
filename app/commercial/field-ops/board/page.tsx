import { redirect } from "next/navigation";

/**
 * R10.7 - the Job Board is retired. Work orders live on the Work Orders tab and
 * are scheduled from the interactive Calendar. Old links fold onto the calendar.
 */
export default function JobBoardPage() {
  redirect("/commercial/field-ops/calendar");
}
