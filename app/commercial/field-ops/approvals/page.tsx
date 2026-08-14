import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  listPendingApprovals,
  approveTimeEntry,
  questionTimeEntry,
  overrideTimeEntryHours,
  bulkApproveZeroVariance,
  type ApprovalRow,
} from "@/lib/commercial/field-ops/approvals";
import { fmtEtDate } from "@/lib/commercial/invoices/format";
import { INPUT_CLS } from "@/lib/commercial/form-classnames";
import { SubmitButton } from "@/components/commercial/submit-button";

export const dynamic = "force-dynamic";
const BASE = "/commercial/field-ops/approvals";

async function requireAdmin(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");
  return user.id;
}

function doneOr(res: { ok: true } | { ok: false; error: string }) {
  revalidatePath(BASE);
  redirect(res.ok ? BASE : `${BASE}?error=${encodeURIComponent(res.error)}`);
}
async function approveAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  doneOr(await approveTimeEntry(String(formData.get("id") ?? ""), userId));
}
async function questionAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  doneOr(await questionTimeEntry(String(formData.get("id") ?? ""), String(formData.get("reason") ?? ""), userId));
}
async function overrideAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  doneOr(await overrideTimeEntryHours(String(formData.get("id") ?? ""), Number(formData.get("hours") ?? 0), userId));
}
async function bulkApproveAction() {
  "use server";
  const userId = await requireAdmin();
  await bulkApproveZeroVariance(userId);
  revalidatePath(BASE);
  redirect(`${BASE}?ok=bulk`);
}

function varTone(v: number | null): string {
  if (v == null) return "text-ppp-charcoal-400";
  if (v === 0) return "text-ppp-green-700";
  return v < 0 ? "text-rose-600" : "text-amber-700";
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const rows = await listPendingApprovals();
  // Capped-guess (force-closed) rows are excluded from the zero-variance sweep —
  // they need a human eye — so the button count must exclude them too.
  const zeroCount = rows.filter((r) => r.status === "submitted" && r.variance === 0 && !r.capped && !r.absent).length;

  // Group by employee.
  const byEmp = new Map<string, { name: string; rows: ApprovalRow[] }>();
  for (const r of rows) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, { name: r.employee_name, rows: [] });
    byEmp.get(r.employee_id)!.rows.push(r);
  }

  return (
    <div className="pb-8 max-w-4xl">
      <div className="mb-4 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Approvals</h1>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1">Scheduled vs. clocked hours. Approve, question (sends it back), or fix the hours yourself.</p>
          {sp.error && <div className="mt-2 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{sp.error}</div>}
        </div>
        {zeroCount > 0 && (
          <form action={bulkApproveAction}>
            <SubmitButton
              className="inline-flex items-center px-3 py-2 rounded-lg bg-ppp-green-600 text-white text-[12.5px] font-semibold hover:bg-ppp-green-700 min-h-[44px] sm:min-h-[40px]"
            >Approve {zeroCount} matching</SubmitButton>
          </form>
        )}
      </div>

      {sp.ok === "bulk" && <div className="mb-4 rounded-lg bg-ppp-green-50 border border-ppp-green-100 px-3 py-2 text-[12.5px] text-ppp-green-700">Zero-variance entries approved.</div>}

      {rows.length === 0 ? (
        <div className="text-center py-12 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">Nothing to approve</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Time shows up here as the crew clocks in and out.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {[...byEmp.values()].map((grp) => (
            <div key={grp.name} className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-ppp-charcoal-50 border-b border-ppp-charcoal-100 flex items-center justify-between">
                <span className="text-[13px] font-bold text-ppp-charcoal">{grp.name}</span>
                <span className="text-[11px] text-ppp-charcoal-400">{grp.rows.length} entr{grp.rows.length === 1 ? "y" : "ies"}</span>
              </div>
              <ul className="divide-y divide-ppp-charcoal-50">
                {grp.rows.map((r) => (
                  <li key={r.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-semibold text-ppp-charcoal truncate">{r.job_name}</div>
                        <div className="text-[11px] text-ppp-charcoal-500">{fmtEtDate(r.work_date)} · {r.source === "clocked" ? "clocked" : "manual"}{r.status === "questioned" ? " · questioned" : ""}{r.capped && <span className="text-amber-700 font-semibold"> · capped guess — review</span>}{r.absent && <span className="text-rose-700 font-semibold"> · marked absent — review</span>}</div>
                        {r.status === "questioned" && r.questioned_reason && (
                          <div className="text-[11px] text-amber-800 mt-0.5">“{r.questioned_reason}”</div>
                        )}
                      </div>
                      <div className="text-[12px] tabular-nums text-ppp-charcoal-600">
                        <span className="text-ppp-charcoal-400">{r.scheduled ?? "—"}h</span> → <span className="font-bold text-ppp-charcoal">{r.actual}h</span>
                        {r.variance != null && r.variance !== 0 && <span className={`ml-1.5 font-semibold ${varTone(r.variance)}`}>({r.variance > 0 ? "+" : ""}{r.variance})</span>}
                      </div>
                      <form action={approveAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <SubmitButton
                          className="inline-flex items-center px-3 rounded-lg bg-ppp-green-50 text-ppp-green-700 text-[12px] font-semibold hover:bg-ppp-green-100 min-h-[44px] touch-manipulation"
                        >Approve</SubmitButton>
                      </form>
                      <details className="relative">
                        <summary className="list-none cursor-pointer text-[12px] font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal px-2 min-h-[44px] inline-flex items-center touch-manipulation">More</summary>
                        <div className="mt-2 flex flex-col gap-2 bg-ppp-charcoal-50/60 rounded-lg p-2">
                          <form action={overrideAction} className="flex items-center gap-2">
                            <input type="hidden" name="id" value={r.id} />
                            <input name="hours" type="number" min="0" max="24" step="0.25" defaultValue={r.actual} className={`${INPUT_CLS} w-20`} />
                            <SubmitButton
                              className="shrink-0 inline-flex items-center px-3 min-h-[44px] rounded-lg text-[12px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50 touch-manipulation"
                            >Set hours</SubmitButton>
                          </form>
                          <form action={questionAction} className="flex items-center gap-2">
                            <input type="hidden" name="id" value={r.id} />
                            <input name="reason" placeholder="What's wrong?" className={`${INPUT_CLS} flex-1`} />
                            <SubmitButton
                              className="shrink-0 inline-flex items-center px-3 min-h-[44px] rounded-lg text-[12px] font-semibold text-amber-700 hover:bg-amber-50 touch-manipulation"
                            >Question</SubmitButton>
                          </form>
                        </div>
                      </details>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
