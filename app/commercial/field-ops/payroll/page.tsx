import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getPayrollSummary } from "@/lib/commercial/field-ops/payroll";
import { addDaysIso, todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { fmtEtDate } from "@/lib/commercial/invoices/format";
import { DateField } from "@/components/commercial/date-field";
import { LABEL_CLS } from "@/lib/commercial/form-classnames";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";

export const dynamic = "force-dynamic";

async function requireAdmin(): Promise<void> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");
}

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; empty?: string; needsconfirm?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const today = todayEtIso();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : addDaysIso(today, -13);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : today;
  const { rows, approvedCount, unapprovedCount, periodStart, periodEnd, w2Workforce } = await getPayrollSummary(from, to);
  // Nobody on payroll at all is a different situation from nobody approved
  // THIS period, and only one of them has an action attached. Tomco is the
  // former permanently: every crew member is a sub, paid through a labor
  // company, so their hours live on Attendance and their cost on Labor
  // payments. Telling them to "approve time or widen the range" sends them
  // looking for a row that cannot exist.
  const noPayrollWorkforce = w2Workforce === 0;
  const totals = rows.reduce((t, r) => ({ reg: t.reg + r.regHours, ot: t.ot + r.otHours, all: t.all + r.totalHours }), { reg: 0, ot: 0, all: 0 });
  // OT is a whole-week concept, so the summary snaps the range out to full
  // Mon-Sun weeks. Surface it when the picked range wasn't already aligned.
  const snapped = periodStart !== from || periodEnd !== to;

  return (
    <div className="pb-8 max-w-4xl">
      <div className="mb-4">
        {/* NAMED APART FROM ACCOUNTING → PAYROLL, deliberately.
            Since the crew went W-2 there are two screens a person could call
            "payroll": this one, which is HOURS (overtime split, CSV export),
            and Accounting → Payroll, which is MONEY (the Gusto cost back, the
            split across jobs, posting it). They cover different halves and,
            because this one takes an arbitrary date range and that one is
            strictly Mon–Sun, their totals can legitimately differ — which
            looks like a contradiction if both are just called "Payroll". */}
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Payroll hours</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Approved hours for the period, W-2 only, overtime split at 40h/week. Export the CSV for your payroll run.</p>
        <p className="text-[12.5px] text-ppp-charcoal-500 mt-1.5">
          Costing a week and putting it on the jobs happens in{" "}
          <Link
            href="/commercial/accounting?view=payroll"
            className="font-semibold text-cc-brand-700 hover:underline"
          >
            Accounting → Payroll
          </Link>
          .
        </p>
        {snapped && (
          <p className="text-[12px] text-ppp-charcoal-400 mt-1">Overtime is figured per full week, so this covers whole Mon–Sun weeks: <span className="font-semibold text-ppp-charcoal-600">{fmtEtDate(periodStart)} – {fmtEtDate(periodEnd)}</span>.</p>
        )}
      </div>

      {/* Two SIBLING forms in one row, not one inside the other. The range
          picker and the export are different submissions to different places,
          and a nested form is silently dropped by the browser — its button
          then runs the outer form's action instead. */}
      <div className="flex flex-wrap items-end gap-3 mb-4 bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div><span className={LABEL_CLS}>From</span><DateField name="from" defaultValue={from} /></div>
          <div><span className={LABEL_CLS}>To</span><DateField name="to" defaultValue={to} /></div>
          <button type="submit" className="inline-flex items-center px-4 rounded-lg border border-ppp-charcoal-200 text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px]">Update</button>
        </form>
        <div className="flex-1" />
        {/* A FORM, not a link, so it can ask first.
            Exporting is not a download — it flips every approved hour in the
            range to `exported`, which is terminal, and the default range snaps
            out to three whole weeks. As a plain link one mis-aimed tap locked
            three weeks of somebody's pay with no way back short of database
            access. The route now also refuses to lock without `confirm=1`, so
            a prefetch or a pasted URL cannot do it either. */}
        {rows.length > 0 ? (
          <form method="get" action="/api/commercial/field-ops/payroll/export">
            <input type="hidden" name="from" value={from} />
            <input type="hidden" name="to" value={to} />
            <input type="hidden" name="confirm" value="1" />
            <ConfirmSubmitButton
              message={`Export and LOCK approved hours for ${fmtEtDate(periodStart)} – ${fmtEtDate(periodEnd)}? Locked hours cannot be edited, approved or deleted afterwards. Re-download re-issues the file without locking anything.`}
              className="inline-flex items-center px-4 rounded-lg text-[13px] font-semibold min-h-[44px] bg-cc-brand-600 text-white hover:bg-cc-brand-700"
            >
              Export CSV
            </ConfirmSubmitButton>
          </form>
        ) : (
          <span className="inline-flex items-center px-4 rounded-lg text-[13px] font-semibold min-h-[44px] bg-ppp-charcoal-100 text-ppp-charcoal-400">
            Export CSV
          </span>
        )}
        {/* The export is one-shot by design: it locks approved hours so nothing
            can be paid twice. That leaves no way back if the download is
            interrupted, so this re-issues the same file for hours already
            exported — read-only, no status changes, no new pay period.
            Disabled when nobody is on payroll: it would download a file with a
            header row and nothing under it, which reads as "payroll ran and
            found no hours" rather than "this company has no W-2 staff". */}
        <Link
          href={`/api/commercial/field-ops/payroll/export?from=${from}&to=${to}&mode=redownload`}
          prefetch={false}
          className={`inline-flex items-center px-3 rounded-lg border text-[12.5px] font-semibold min-h-[44px] ${noPayrollWorkforce ? "border-ppp-charcoal-100 text-ppp-charcoal-300 pointer-events-none" : "border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"}`}
          aria-disabled={noPayrollWorkforce || undefined}
          title={noPayrollWorkforce ? "Nobody is on payroll, so there is no export to re-issue." : "Re-issue the CSV for hours already exported in this range. Changes nothing."}
        >
          Re-download
        </Link>
      </div>

      {/* The export route bounces back here rather than handing over a CSV with
          nothing in it — see the route for why a blank file is worse than no
          file. */}
      {(sp.empty === "redownload" || sp.empty === "export") && (
        <div className="mb-4 rounded-lg bg-ppp-charcoal-50 border border-ppp-charcoal-200 px-3 py-2 text-[12.5px] text-ppp-charcoal-700">
          {noPayrollWorkforce
            ? "Nothing to download — nobody is on payroll. Every active crew member is a sub, paid through a labor company."
            : sp.empty === "redownload"
              ? `Nothing to re-issue: no payroll has been exported for ${fmtEtDate(periodStart)} – ${fmtEtDate(periodEnd)} yet.`
              : `Nothing to export: no approved W-2 hours in ${fmtEtDate(periodStart)} – ${fmtEtDate(periodEnd)}. Anything already exported has been paid.`}
        </div>
      )}

      {sp.needsconfirm === "1" && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[12.5px] text-amber-800">
          Nothing was exported or locked. Exporting locks the hours it covers, so it only runs
          from the Export button on this page — not from a saved or shared link.
        </div>
      )}

      {unapprovedCount > 0 && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[12.5px] text-amber-800">
          {unapprovedCount} entr{unapprovedCount === 1 ? "y is" : "ies are"} still waiting on approval in this range — <Link href="/commercial/field-ops/approvals" className="font-semibold underline">review them</Link> before you run payroll.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="text-center py-12 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          {noPayrollWorkforce ? (
            <>
              <p className="text-sm font-semibold text-ppp-charcoal">Nobody is on payroll</p>
              <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
                Every active crew member is a sub or temp, paid through a labor company — so this page has nothing to export, in this or any date range.
              </p>
              <p className="text-[12.5px] text-ppp-charcoal-500 mt-2">
                Their <Link href="/commercial/field-ops/hours" className="font-semibold text-cc-brand-700 hover:underline">hours are on Attendance</Link>, and what you paid them is on <Link href="/commercial/accounting?view=labor-out" className="font-semibold text-cc-brand-700 hover:underline">Labor payments</Link>.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-ppp-charcoal">No approved W-2 hours in {fmtEtDate(from)} – {fmtEtDate(to)}</p>
              <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Approve time first, or widen the date range.</p>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto bg-surface border border-ppp-charcoal-100 rounded-xl">
          <table className="w-full text-[13px] min-w-[420px]">
            <thead className="bg-ppp-charcoal-50 text-left text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
              <tr><th className="px-4 py-2">Employee</th><th className="px-3 py-2 text-right">Regular</th><th className="px-3 py-2 text-right">OT</th><th className="px-3 py-2 text-right">Total</th></tr>
            </thead>
            <tbody className="divide-y divide-ppp-charcoal-50">
              {rows.map((r) => (
                <tr key={r.employee_id}>
                  <td className="px-4 py-2 font-medium text-ppp-charcoal">{r.employee_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ppp-charcoal-600">{r.regHours}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.otHours > 0 ? "font-semibold text-amber-700" : "text-ppp-charcoal-400"}`}>{r.otHours}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold text-ppp-charcoal">{r.totalHours}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-ppp-charcoal-50 border-t-2 border-ppp-charcoal-200">
              <tr className="font-bold text-ppp-charcoal">
                <td className="px-4 py-2">Total ({rows.length})</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(totals.reg * 100) / 100}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Math.round(totals.ot * 100) / 100}</td>
                <td className="px-3 py-2 text-right tabular-nums text-cc-brand-700">{Math.round(totals.all * 100) / 100}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-[11px] text-ppp-charcoal-400 mt-2">Based on {approvedCount} approved entr{approvedCount === 1 ? "y" : "ies"}. Subs/temps are excluded from payroll by design.</p>
    </div>
  );
}
