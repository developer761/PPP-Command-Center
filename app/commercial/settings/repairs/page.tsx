import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import {
  findContractRepairs,
  findCertificateRepairs,
  findWinDateRepairs,
  applyContractRepair,
  applyCertificateRepair,
  applyWinDateRepair,
  type RepairRow,
} from "@/lib/commercial/repairs/db";
import { SubmitButton } from "@/components/commercial/submit-button";

export const dynamic = "force-dynamic";

/**
 * Historical repairs.
 *
 * Three bug fixes each stopped a defect recurring but left rows already carrying
 * a wrong figure — an erased signed contract, a certificate that still
 * recalculates, a win date overwritten by close-out. In all three the right
 * answer is recoverable from history, and in all three a script guessing at it
 * would silently rewrite a number on a document a customer signed.
 *
 * So: the proposal is computed, a person reads it, and approves one row at a
 * time. Nothing here runs on its own.
 */

async function requireAdminUser(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin") redirect("/commercial");
  return user.id;
}

async function applyAction(formData: FormData) {
  "use server";
  const userId = await requireAdminUser();
  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  // The exact figure the admin read on screen. The apply refuses if the
  // underlying data has moved since — approving "$450,000" must never write
  // some other number just because the page was open a while.
  const approved = String(formData.get("approved") ?? "");
  const res =
    kind === "contract"
      ? await applyContractRepair(id, userId, approved)
      : kind === "certificate"
        ? await applyCertificateRepair(id, userId, approved)
        : kind === "win_date"
          ? await applyWinDateRepair(id, userId, approved)
          : { ok: false as const, error: "Unknown repair." };
  revalidatePath("/commercial/settings/repairs");
  redirect(
    res.ok
      ? "/commercial/settings/repairs?done=1"
      : `/commercial/settings/repairs?error=${encodeURIComponent(res.error ?? "Repair failed.")}`
  );
}

export default async function RepairsPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; error?: string }>;
}) {
  await requireAdminUser();
  const sp = await searchParams;

  const [contracts, certificates, winDates] = await Promise.all([
    findContractRepairs(),
    findCertificateRepairs(),
    findWinDateRepairs(),
  ]);
  const total = contracts.length + certificates.length + winDates.length;
  const fixable =
    contracts.filter((r) => r.applicable).length +
    certificates.filter((r) => r.applicable).length +
    winDates.filter((r) => r.applicable).length;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div>
        <Link
          href="/commercial/settings"
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ppp-charcoal-600 hover:text-cc-brand-700 min-h-[44px]"
        >
          <span aria-hidden>←</span> Settings
        </Link>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none mt-1">
          Historical repairs
        </h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1.5 leading-relaxed">
          Three bugs have been fixed so they can&rsquo;t happen again. These are the records
          that were already wrong when the fix landed. Each one shows what it says now and
          what it would become — approve them one at a time.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-700">
          {sp.error}
        </div>
      )}
      {sp.done && (
        <div className="rounded-lg px-4 py-3 text-sm bg-emerald-50 border border-emerald-200 text-emerald-800">
          Repaired.
        </div>
      )}

      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-ppp-charcoal-200 bg-surface px-4 py-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">Nothing to repair.</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">
            No record is carrying a figure from before those fixes.
          </p>
        </div>
      ) : (
        <p className="text-[12.5px] text-ppp-charcoal-600">
          <strong className="text-ppp-charcoal">{total}</strong>{" "}
          {total === 1 ? "record needs" : "records need"} attention
          {fixable < total && (
            <>
              {" "}— <strong className="text-ppp-charcoal">{total - fixable}</strong> of them can&rsquo;t
              be recovered from history and need setting by hand
            </>
          )}
          .
        </p>
      )}

      <RepairSection
        kind="contract"
        title="Signed contracts erased by a re-quote"
        blurb="These deals were won, then re-quoted — which retired the winning proposal and took the agreed figure with it. The amount is read back from the audit log."
        rows={contracts}
      />
      <RepairSection
        kind="certificate"
        title="Certificates that still recalculate"
        blurb="Issued before payment applications started locking their figures, so approving a change order can still restate what they say. Reconstructed from the frozen schedule of values — check against the copy sent to the GC."
        rows={certificates}
      />
      <RepairSection
        kind="win_date"
        title="Win dates overwritten by close-out"
        blurb="Finishing a job's close-out used to overwrite the day it was won, so these deals count in the wrong month. The real date comes from the status log."
        rows={winDates}
      />
    </div>
  );
}

function RepairSection({
  kind,
  title,
  blurb,
  rows,
}: {
  kind: string;
  title: string;
  blurb: string;
  rows: RepairRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <section className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-ppp-charcoal-100">
        <h2 className="text-sm font-bold text-ppp-charcoal">
          {title}{" "}
          <span className="text-ppp-charcoal-400 font-semibold">({rows.length})</span>
        </h2>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 leading-relaxed">{blurb}</p>
      </div>
      <ul className="divide-y divide-ppp-charcoal-50">
        {rows.map((r) => (
          <li key={r.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-ppp-charcoal">{r.label}</span>
                  {r.sublabel && (
                    <span className="font-mono text-[10.5px] text-ppp-navy-600">{r.sublabel}</span>
                  )}
                  {r.confidence === "derived" && (
                    <span className="inline-flex items-center h-[18px] px-1.5 rounded-full text-[9.5px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                      Reconstructed
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-ppp-charcoal-600 mt-1 tabular-nums">
                  <span className="text-ppp-charcoal-400">Now:</span> {r.current}
                </div>
                <div className="text-[12px] text-ppp-charcoal-800 font-semibold mt-0.5 tabular-nums">
                  <span className="text-ppp-charcoal-400 font-normal">Would become:</span>{" "}
                  {r.proposed}
                </div>
                {r.note && (
                  <p className="text-[11.5px] text-ppp-charcoal-500 mt-1 leading-relaxed">{r.note}</p>
                )}
              </div>
              {r.applicable ? (
                <form action={applyAction}>
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="approved" value={r.proposed} />
                  <SubmitButton
                    className="inline-flex items-center px-3 py-1.5 rounded-lg border border-cc-brand-200 bg-surface text-[12px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50 min-h-[44px] sm:min-h-[36px]"
                  >
                    Apply
                  </SubmitButton>
                </form>
              ) : (
                <span className="text-[11.5px] text-ppp-charcoal-400 shrink-0 self-center">
                  By hand
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
