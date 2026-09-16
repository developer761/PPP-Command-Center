import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { listAiaApplications, resolveG702 } from "@/lib/commercial/aia/db";
import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";

/**
 * Mary's Accounts Receivable sheet, generated.
 *
 * She keeps this in Excel today and sends it on: three columns — Job,
 * Billed/Open, Notes — one row per AIA application, with retention as its OWN
 * row, and the Notes column doing the real work ("revision sent 9/3 and s/b
 * paid in a few weeks", "9/10 asked for update"). Her 2026-09-16 copy totals
 * $314,048.14.
 *
 * Karan chose the honest version (2026-09-16): Mary raises the applications in
 * the platform from now on and this report builds itself from them, rather than
 * the platform imitating a spreadsheet that is maintained by hand. So every row
 * here is a real certificate — nothing is typed twice, the totals cannot drift
 * from the job, and the note lives on the application where anyone looking at
 * the job can see it.
 *
 * It is empty until she raises the first one. That is correct, and the page
 * says so rather than showing a zero as though the book were clear.
 */

export type ArApplicationRow = {
  id: string;
  oppId: string;
  jobName: string;
  accountName: string;
  /** "AIA#4 · 21 May 26" — how she labels the line. */
  label: string;
  /** A retention line, which she splits out from the payment it belongs to. */
  isRetention: boolean;
  openCents: number;
  notes: string | null;
  issuedYmd: string | null;
};

const fmtDay = (ymd: string | null): string => {
  if (!ymd) return "";
  const [y, m, d] = ymd.slice(0, 10).split("-");
  return `${Number(d)}/${Number(m)}/${y.slice(2)}`;
};

export async function getArApplicationRows(): Promise<ArApplicationRow[]> {
  const sb = commercialDb();

  // Only jobs that are actually billing this way. An opportunity with no
  // application contributes nothing and is not worth a round-trip.
  const apps = await paginateAll<{ id: string; opportunity_id: string }>(() =>
    sb
      .from("commercial_aia_applications")
      .select("id, opportunity_id")
      .is("deleted_at", null)
      .order("id", { ascending: true })
  );
  if (apps.length === 0) return [];

  const oppIds = [...new Set(apps.map((a) => a.opportunity_id))];
  const opps = await paginateAll<{
    id: string;
    account_id: string;
    title: string | null;
    client_name: string | null;
    title_override: string | null;
    title_override_mode: string | null;
    property_street: string | null;
  }>(() =>
    sb
      .from("commercial_opportunities")
      .select("id, account_id, title, client_name, title_override, title_override_mode, property_street")
      .in("id", oppIds)
      .order("id", { ascending: true })
  );
  const { data: accounts } = await sb
    .from("commercial_accounts")
    .select("id, company_name")
    .in("id", [...new Set(opps.map((o) => o.account_id))]);
  const acct = new Map(((accounts ?? []) as { id: string; company_name: string | null }[]).map((a) => [a.id, a.company_name]));
  const jobOf = new Map(
    opps.map((o) => [
      o.id,
      {
        name: derivedOppName({ ...o, title: o.title ?? "" }, acct.get(o.account_id) ?? null),
        account: acct.get(o.account_id) ?? "—",
      },
    ])
  );

  const rows: ArApplicationRow[] = [];
  for (const oppId of oppIds) {
    const job = jobOf.get(oppId);
    if (!job) continue;
    // Issued certificates only: a draft has been sent to nobody, so it is not
    // a receivable.
    const issued = (await listAiaApplications(oppId)).filter((a) => a.status !== "draft" && !a.deleted_at);
    for (const app of issued) {
      const g702 = await resolveG702(app.id);
      if (!g702) continue;
      const label = `AIA#${app.application_number}`;
      const day = app.period_to ?? (app.frozen_at ? String(app.frozen_at).slice(0, 10) : null);
      if (g702.currentPaymentDueCents > 0) {
        rows.push({
          id: app.id,
          oppId,
          jobName: job.name,
          accountName: job.account,
          label: `${label} · ${fmtDay(day)}`.trim(),
          isRetention: false,
          openCents: g702.currentPaymentDueCents,
          notes: app.notes,
          issuedYmd: day,
        });
      }
      // Retention on its own line, the way she writes it. It is held, not
      // late — putting it in the same row as the payment hides how much of
      // what is "open" is money nobody is chasing yet.
      if (g702.retainageCents > 0 && !app.is_retainage_release) {
        rows.push({
          id: `${app.id}:retention`,
          oppId,
          jobName: job.name,
          accountName: job.account,
          label: `${label} · ${fmtDay(day)} · Retention`.trim(),
          isRetention: true,
          openCents: g702.retainageCents,
          notes: null,
          issuedYmd: day,
        });
      }
    }
  }
  return rows.sort((a, b) => (b.issuedYmd ?? "").localeCompare(a.issuedYmd ?? "") || b.openCents - a.openCents);
}

export const AR_APPLICATIONS_SPEC: ReportSpec<ArApplicationRow> = {
  title: "Accounts Receivable",
  sourceLabel: "AIA applications",
  blurb:
    "Mary's sheet, generated: one line per certificate, retention on its own line, with the note that says where it stands. Raise an application on a job and it appears here.",
  totals: [
    { label: "Billed / open", value: (rows) => rows.reduce((n, r) => n + r.openCents, 0) },
    { label: "Of which retention", value: (rows) => rows.filter((r) => r.isRetention).reduce((n, r) => n + r.openCents, 0) },
  ],
  groupings: [
    [{ key: "job", label: "Job", of: (r) => r.jobName }],
    [{ key: "gc", label: "GC", of: (r) => r.accountName }],
    [{ key: "month", label: "Month", of: (r) => (r.issuedYmd ? r.issuedYmd.slice(0, 7) : "—") }],
  ],
  columns: [
    { key: "label", label: "Application", text: (r) => r.label, href: (r) => `/commercial/opportunities/${r.oppId}?tab=project&sub=aia` },
    { key: "open", label: "Billed / open", kind: "money", amount: (r) => r.openCents },
    { key: "notes", label: "Notes", text: (r) => r.notes },
  ],
};
