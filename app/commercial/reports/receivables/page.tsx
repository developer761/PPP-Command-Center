import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getReceivablesReport, setReceivableNote } from "@/lib/commercial/reports/receivables";
import { formatCentsFull } from "@/lib/commercial/invoices/format";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { ReceivablesTable } from "@/components/commercial/receivables-table";
import { getCachedBrief, generateBrief, briefAvailable } from "@/lib/commercial/reports/receivables-brief";
import { sendReceivablesToAlex, receivablesRecipients } from "@/lib/commercial/reports/receivables-email";
import { fmtEtDate } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

const BASE = "/commercial/reports/receivables";

/**
 * RECEIVABLES — Alex's ask (2026-08-19), modelled on the sheet Mary keeps by
 * hand: "all jobs we have invoiced completed or progress."
 *
 * Her sheet is Job · Billed/Open · Notes, biggest first, one total at the
 * bottom. This is that, with the reference column generated (she hand-types
 * "AIA#3-7/22/26"; we already hold the application number and the date) so the
 * only thing anyone writes is the part that is genuinely a person's knowledge.
 *
 * Deliberately NOT merged with the existing AR-aging report. That one buckets
 * by days overdue — it answers "who is late". This answers "what is out, and
 * what's happening with it", which is a different question and the one Alex
 * actually asked.
 */

async function saveNoteAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const rowKey = String(formData.get("row_key") ?? "");
  if (!rowKey) redirect(BASE);
  const res = await setReceivableNote(rowKey, String(formData.get("note") ?? ""), user.id);
  revalidatePath(BASE);
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  redirect(`${BASE}?saved=1`);
}

/** Write a fresh brief. Its own action so a slow model call never delays the
 *  report — the page renders from cache and this is an explicit click. */
async function refreshBriefAction() {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const res = await generateBrief(await getReceivablesReport());
  revalidatePath(BASE);
  redirect(res.ok ? `${BASE}?brief=1` : `${BASE}?error=${encodeURIComponent(res.error)}`);
}

/** Email the sheet. Mary's last step — the one she does by hand today.
 *  A send is deliberate and explicit: no auto-send, no scheduled surprise from
 *  this button. The daily cron, when it lands, calls the same helper. */
async function sendToAlexAction() {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const res = await sendReceivablesToAlex();
  revalidatePath(BASE);
  redirect(
    res.ok
      ? `${BASE}?sent=${encodeURIComponent(res.to.join(", "))}`
      : `${BASE}?error=${encodeURIComponent(res.error)}`
  );
}

function pickFirst(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v ?? undefined;
}


export default async function ReceivablesReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const report = await getReceivablesReport();
  const error = pickFirst(sp.error);
  const saved = pickFirst(sp.saved) === "1";
  const sentTo = pickFirst(sp.sent);
  const recipients = receivablesRecipients();
  const { brief, stale } = await getCachedBrief(report);
  const canBrief = briefAvailable();

  return (
    <div className="max-w-[1400px] mx-auto px-3 sm:px-6 py-6 space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">
            Receivables
          </h1>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-2xl">
            Every job with money out — invoices and AIA applications together, biggest first.
            Add a note after a chase and it stays with the job.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href="/commercial/reports/ar-aging"
            className="text-[12px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center mr-1"
          >
            AR aging →
          </Link>
          {/* A plain link, not a fetch — the browser downloads it and the file
              is byte-identical to the one attached to Alex's email. */}
          <a
            href="/api/commercial/reports/receivables/export"
            className="inline-flex items-center min-h-[40px] px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal hover:border-cc-brand-300 hover:text-cc-brand-700 transition-colors"
          >
            Export sheet
          </a>
          {report.rows.length > 0 && (
            <form action={sendToAlexAction} className="flex flex-col items-end gap-0.5">
              <PendingSubmitButton
                pendingLabel="Sending…"
                className="inline-flex items-center min-h-[40px] px-3 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 transition-colors"
              >
                Send to Alex
              </PendingSubmitButton>
              {/* Name the recipient. A send button whose destination you have
                  to guess is one nobody presses. */}
              <span className="text-[10px] text-ppp-charcoal-400">{recipients.join(", ")}</span>
            </form>
          )}
        </div>
      </div>

      {saved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Note saved.
        </div>
      )}
      {sentTo && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Sent to {sentTo} — the figures, the notes, and the sheet attached.
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800">
          {error}
        </div>
      )}

      {/* ── The brief ────────────────────────────────────────────────────
          One read on the whole book, for Alex. Cached and labelled rather than
          regenerated per view: this page gets refreshed all day, and spending a
          model call plus seconds of latency on every load to restate numbers
          that are already on screen would be a poor trade. Stale-but-dated
          beats slow. */}
      {canBrief && (
        <section className="bg-surface border border-ppp-charcoal-100 border-l-4 border-l-cc-brand-500 rounded-xl p-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1.5">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700">
              The brief
            </h2>
            <form action={refreshBriefAction}>
              <PendingSubmitButton
                pendingLabel="Writing…"
                className="text-[11.5px] font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal min-h-[32px] inline-flex items-center"
              >
                {brief ? "Rewrite" : "Write the brief"}
              </PendingSubmitButton>
            </form>
          </div>
          {brief ? (
            <>
              <p className="text-[13.5px] text-ppp-charcoal leading-relaxed">{brief.text}</p>
              <p className="text-[10.5px] text-ppp-charcoal-400 mt-2">
                {stale
                  // Say so rather than quietly showing an old read of a book
                  // that has since moved.
                  ? "Written before the latest changes — rewrite for a current read."
                  : `Written ${fmtEtDate(brief.generatedAt)}`}
              </p>
            </>
          ) : (
            <p className="text-[12.5px] text-ppp-charcoal-500">
              A short read on where the money is and what to chase first.
            </p>
          )}
        </section>
      )}

      {/* Total first — it's the number Alex opens this for. Mary's sheet ends
          with it; on a screen it belongs at the top. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Total outstanding" value={formatCentsFull(report.totalOpenCents)} tone="brand" sub={`${report.rows.length} open item${report.rows.length === 1 ? "" : "s"}`} />
        <Tile label="Collectible now" value={formatCentsFull(report.dueNowCents)} tone="navy" sub="excludes retention" />
        <Tile label="Past due" value={formatCentsFull(report.overdueCents)} tone={report.overdueCents > 0 ? "rose" : "neutral"} sub={report.overdueCents > 0 ? "chase these first" : "nothing late"} />
        <Tile label="Retention held" value={formatCentsFull(report.retainageCents)} tone="neutral" sub="released at close-out" />
      </div>

      <ReceivablesTable
        rows={report.rows}
        totalOpenCents={report.totalOpenCents}
        saveNoteAction={saveNoteAction}
      />

    </div>
  );
}


function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "brand" | "navy" | "rose" | "neutral";
}) {
  const v =
    tone === "brand" ? "text-cc-brand-700"
    : tone === "navy" ? "text-ppp-navy-700"
    : tone === "rose" ? "text-rose-700"
    : "text-ppp-charcoal";
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-3.5 py-3">
      <div className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[22px] font-black tabular-nums leading-none mt-1 ${v}`}>{value}</div>
      {sub && <div className="text-[10.5px] text-ppp-charcoal-400 mt-1">{sub}</div>}
    </div>
  );
}
