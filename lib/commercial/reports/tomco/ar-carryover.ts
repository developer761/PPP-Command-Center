/**
 * Mary's Accounts Receivable sheet as it stood on 16 September 2026, copied.
 *
 * She keeps this in Excel and sends it on. Karan: "just copy the sheet." So
 * this is it — her rows, her wording, her order, her figures. Nothing is
 * matched to a job, nothing is recalculated, nothing is inferred: the only
 * thing done to it was reading the numbers out of the file.
 *
 * It totals $314,048.14, which is the total printed on her sheet. That is the
 * check that it was read correctly, and there is a test that holds it.
 *
 * WHY A SNAPSHOT AND NOT A LIVE QUERY. Every line is an AIA certificate, and
 * the platform holds none — Salesforce never had them as records, so there was
 * nothing to migrate. Karan's decision (2026-09-16) is that Mary raises
 * certificates in the platform from now on and the sheet builds itself from
 * them. Until the first one is raised, this is the sheet. As certificates
 * arrive they appear alongside these rows, and a carried-over line is retired
 * once its certificate exists.
 *
 * WHERE A JOB IS BLANK, the row continues the job above it — that is how the
 * cells are merged in her file. It is stated on screen rather than silently
 * filled in.
 */

export type ArCarryoverRow = {
  /** Her "Job" column, exactly as she writes it. */
  job: string;
  /** Her "Billed/Open" column, in cents. */
  openCents: number;
  /** Her "Notes" column, verbatim — this is the working part of her sheet. */
  note: string;
};

/** The day the copy was taken. Shown on screen so nobody reads it as live. */
export const AR_CARRYOVER_AS_OF = "2026-09-16";

export const AR_CARRYOVER: ArCarryoverRow[] = [
  { job: "O'Shea Properties", openCents: 250_000, note: "9/3/26 - invoiced" },
  { job: "LMJ - Duct Patches", openCents: 7_500, note: "Retention" },
  { job: "LMJ - Duct Patches", openCents: 55_000, note: "AIA#4 - 5/21/26 - Retention" },
  { job: "The Bannet Group", openCents: 1_000_000, note: "AIA#1 - 7/16/26" },
  { job: "The Bannet Group", openCents: 150_000, note: "7/16/2026 - e/m 9/16" },
  { job: "DuCon - Landlord", openCents: 85_500, note: "AIA#1 - 7/22/26" },
  { job: "DuCon - Landlord", openCents: 9_500, note: "AIA#2 - 7/22/26 - Retention" },
  { job: "DuCon - Landlord", openCents: 2_068_625, note: "AIA#4 - 7/22/26 — revision sent 9/3 and s/b paid in a few weeks" },
  { job: "LMJ Cipla Expansion", openCents: 95_000, note: "AIA#5 - 7/30/26" },
  { job: "LMJ Cipla Expansion", openCents: 5_000, note: "AIA#7 - 7/30/26 - Retention" },
  { job: "CBD - Panera Bread", openCents: 484_500, note: "AIA#1 - 8/12/26" },
  { job: "CBD - Panera Bread", openCents: 1_373_040, note: "AIA#2 - 8/21/26" },
  { job: "CBD - Panera Bread", openCents: 144_531, note: "AIA#3 - 8/21/26 Retention" },
  { job: "The Bannet Group", openCents: 2_025_000, note: "AIA#2 - 8/21/26" },
  { job: "The Bannet Group", openCents: 299_250, note: "AIA#1 - 8/21/26" },
  { job: "The Bannet Group", openCents: 15_750, note: "AIA#2 - 8/21/26 Retention" },
  { job: "LMJ - AIREF", openCents: 17_773_393, note: "AIA#4 - 8/21/26" },
  { job: "LMJ - AIREF", openCents: 295_000, note: "8/25/2026" },
  { job: "LMJ - Fragrance", openCents: 315_000, note: "8/25/2026 - revised 9/16 no tax" },
  { job: "LMJ - Fragrance", openCents: 1_680_000, note: "8/25/2026 - 9/10 asked for update" },
  { job: "LMJ - Fragrance", openCents: 2_885_625, note: "AIA#3 - 8/21/26" },
  { job: "CBD - Panera Bread", openCents: 387_600, note: "AIA#2 - 9/14/26" },
];

/** The total printed at the foot of her sheet: $314,048.14. */
export const AR_CARRYOVER_TOTAL_CENTS = 31_404_814;

export const arCarryoverTotal = (): number =>
  AR_CARRYOVER.reduce((n, r) => n + r.openCents, 0);
