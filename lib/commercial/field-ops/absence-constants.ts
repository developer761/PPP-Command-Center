/**
 * Absence type vocabulary — client-safe (no server-only), so both the Calendar
 * UI and the server absences lib share ONE source for the P/S/NW/NA codes.
 */

export const ABSENCE_TYPES = [
  { code: "PTO", label: "PTO", short: "PTO" },
  { code: "SICK", label: "Sick", short: "S" },
  { code: "PERSONAL", label: "Personal", short: "P" },
  { code: "HOLIDAY", label: "Holiday", short: "HOL" },
  { code: "NO_WORK", label: "No work", short: "NW" },
  { code: "NOT_AVAILABLE", label: "Not available", short: "NA" },
] as const;

export type AbsenceType = (typeof ABSENCE_TYPES)[number]["code"];

const TYPE_META = new Map(ABSENCE_TYPES.map((t) => [t.code, t]));
export function absenceLabel(code: string): string {
  return TYPE_META.get(code as AbsenceType)?.label ?? code;
}
export function absenceShort(code: string): string {
  return TYPE_META.get(code as AbsenceType)?.short ?? code;
}
export function isAbsenceType(v: string): v is AbsenceType {
  return TYPE_META.has(v as AbsenceType);
}
