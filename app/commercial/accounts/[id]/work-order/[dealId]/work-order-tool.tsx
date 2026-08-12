/**
 * Work Order — the crew's marching-orders sheet for a job. Autofills scope
 * (Inclusions / Alternates / Exclusions) from the accepted proposal + the Room
 * Finish Schedule, generates a Tomco-letterhead PDF (tap-to-sign), and files it
 * to the deal's Documents on "Send to Field Ops". Same account-scoped tool pattern as
 * Closeout / AIA / Change Orders / Submittals.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { fmtEtDate } from "@/lib/commercial/invoices/format";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  listWorkOrdersForOpp,
  listPickableScopeForOpp,
  listUnassignedScopeForOpp,
  getWorkOrder,
  createWorkOrder,
  updateWorkOrder,
  changeWorkOrderStatus,
  setWorkOrderSnapshot,
  markWorkOrderEmailed,
  buildWorkOrderContent,
} from "@/lib/commercial/work-orders/db";
import {
  WORK_ORDER_STATUS_META,
  ALLOWED_WORK_ORDER_TRANSITIONS,
  isWorkOrderEditable,
  type WorkOrderStatus,
} from "@/lib/commercial/work-orders/constants";
import { safeDocName, sentStampNote } from "@/lib/commercial/documents/auto-file";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { ToolBackHeader } from "@/components/commercial/tool-back-header";
import { workOrderRecordId } from "@/lib/commercial/record-ids";
import { AutosaveForm } from "@/components/commercial/autosave-form";
import { DateField } from "@/components/commercial/date-field";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

export type WorkOrderSP = { error?: string; ok?: string; emailed?: string; emailfail?: string; filefail?: string; back?: string; /** Which of the deal's work orders to show (migration 123 allows several). */ wo?: string };

async function requireUser(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}
function backQ(back: string): string {
  return back && back.startsWith("/commercial/post-job/") ? `&back=${encodeURIComponent(back)}` : "";
}
function base(id: string, dealId: string, origin?: string, woId?: string | null) {
  // Stay on the standalone tool page when the action came from there; only the
  // embedded Project-tab usage returns to the account page (its canonical home).
  //
  // `woId` keeps you on the SHEET you acted on. Without it every action landed
  // back on sheet A: create sheet B and you'd be editing A while B's chip sat
  // there unselected (tick "the other half" and you've just replaced A's
  // scope); send sheet B and A would render the green "Sent to Field Ops"
  // banner directly above its own Draft pill.
  const woQs = woId ? `&wo=${woId}` : "";
  return origin === "route"
    ? `/commercial/accounts/${id}/work-order/${dealId}?v=1${woQs}`
    : `/commercial/accounts/${id}?tab=projects&project=${dealId}&dt=work-order${woQs}`;
}
function revalidateWO(id: string, dealId: string) {
  revalidatePath(`/commercial/accounts/${id}/work-order/${dealId}`);
  revalidatePath(`/commercial/accounts/${id}`);
  revalidatePath("/commercial/post-job/work-orders");
}
function ymd(raw: string): string | null {
  const s = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
async function woBelongs(woId: string, id: string, dealId: string): Promise<boolean> {
  const w = await getWorkOrder(woId);
  return !!w && w.account_id === id && w.opportunity_id === dealId;
}

// ── Server actions ──────────────────────────────────────────────────
async function createWorkOrderAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) redirect("/commercial/accounts");
  // "Open the work order" reuses the deal's existing sheet; "Add another work
  // order" deliberately makes a second one (migration 123 allows several).
  const another = String(formData.get("another") ?? "") === "1";
  const res = await createWorkOrder({
    opportunity_id: dealId,
    created_by_user_id: userId,
    reuse_existing: !another,
  });
  if (!res.ok) redirect(`${base(id, dealId, origin)}&error=${encodeURIComponent(res.error)}${backQ(back)}`);
  revalidateWO(id, dealId);
  redirect(`${base(id, dealId, origin, res.value.id)}${backQ(back)}`);
}

/** Autosave the editable draft fields (crew, start date, notes). */
async function autosaveWorkOrderAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const woId = String(formData.get("wo_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(woId)) throw new Error("Invalid ids");
  if (!(await woBelongs(woId, id, dealId))) throw new Error("Work order not found");
  const res = await updateWorkOrder(
    woId,
    {
      assigned_to: String(formData.get("assigned_to") ?? "").trim() || null,
      crew_email: String(formData.get("crew_email") ?? "").trim() || null,
      scheduled_start_date: ymd(String(formData.get("scheduled_start_date") ?? "")),
      scheduled_end_date: ymd(String(formData.get("scheduled_end_date") ?? "")),
      work_notes: String(formData.get("work_notes") ?? "").trim() || null,
      area_label: String(formData.get("area_label") ?? "").trim() || null,
      // One value per checked box. An empty selection means "the whole
      // proposal" (migration 123), which is exactly what you want when the
      // user unticks everything — the sheet falls back to full scope rather
      // than printing nothing.
      scope_line_item_ids: formData.getAll("scope_ids").map(String),
    },
    userId
  );
  if (!res.ok) throw new Error(res.error);
  revalidateWO(id, dealId);
}

async function changeStatusAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const woId = String(formData.get("wo_id") ?? "");
  const to = String(formData.get("to") ?? "") as WorkOrderStatus;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(woId)) redirect("/commercial/accounts");
  if (!(await woBelongs(woId, id, dealId))) redirect("/commercial/accounts");
  const res = await changeWorkOrderStatus(woId, to, userId);
  if (!res.ok) redirect(`${base(id, dealId, origin, woId)}&error=${encodeURIComponent(res.error)}${backQ(back)}`);
  // File the frozen PDF into Documents when the WO is sent to the crew — and, if
  // a crew email is on file, email them that exact PDF.
  let emailFlag = "";
  let fileFailed = false;
  if (to === "sent") {
    const filed = await autoFileWorkOrder(id, dealId, woId, userId);
    if (!filed) {
      // Status already flipped to 'sent', but the PDF didn't render/file — don't
      // claim it was filed, and skip the (now PDF-less) crew email.
      fileFailed = true;
    } else if (res.value.crew_email) {
      const sent = await emailWorkOrderToCrew(res.value.crew_email, filed.dealName, filed.pdf);
      if (sent) {
        await markWorkOrderEmailed(woId);
        emailFlag = "&emailed=1";
      } else {
        emailFlag = "&emailfail=1";
      }
    }
  }
  revalidateWO(id, dealId);
  if (fileFailed) redirect(`${base(id, dealId, origin, woId)}&filefail=1${backQ(back)}`);
  redirect(`${base(id, dealId, origin, woId)}&ok=1${emailFlag}${backQ(back)}`);
}

/** Email the crew the Work Order PDF (commercial channel). Best-effort — a
 *  failure never blocks the send (the PDF is already filed to Documents). */
async function emailWorkOrderToCrew(to: string, dealName: string, pdf: Buffer): Promise<boolean> {
  try {
    // `to` is a comma-joined list (one or more foreman/crew emails).
    const recipients = to.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
    if (recipients.length === 0) return false;
    const { sendEmail } = await import("@/lib/email/resend");
    const oc = await getOperatingCompany();
    const r = await sendEmail({
      channel: "commercial",
      to: recipients,
      subject: `Work Order — ${dealName}`,
      text: [
        `Attached is the Work Order for ${dealName}.`,
        "",
        "Scope of work, paint colors & finishes, and any crew notes are on the sheet.",
        "",
        `— ${oc.name}`,
      ].join("\n"),
      attachments: [{ filename: safeDocName("Work_Order", dealName) + ".pdf", content: pdf }],
      tags: [{ name: "kind", value: "work_order_crew" }],
    });
    return r.ok;
  } catch (err) {
    console.warn("[work-order] crew email failed:", err);
    return false;
  }
}

/** Render + file the Work Order PDF as a deal document (category work_order).
 *  Best-effort — never blocks the status change. Returns the rendered PDF +
 *  deal name so the caller can also email it to the crew without re-rendering. */
async function autoFileWorkOrder(
  accountId: string,
  dealId: string,
  woId: string,
  userId: string
): Promise<{ pdf: Buffer; dealName: string } | null> {
  try {
    const wo = await getWorkOrder(woId);
    if (!wo) return null;
    const [opp, account, content, allScope] = await Promise.all([
      getCommercialOpportunity(dealId),
      getCommercialAccount(accountId),
      buildWorkOrderContent(dealId, wo.scope_line_item_ids),
      // Unfiltered, so we can say "4 of 8" rather than just listing 4.
      buildWorkOrderContent(dealId, null),
    ]);
    // Base inclusions only — see the note in the work-order PDF route.
    const allScopeCount = allScope.inclusions.length;
    if (!opp || !account) return null;
    const dealName = derivedOppName(opp, account.company_name);
    const oc = await getOperatingCompany();
    const { getBrandLogoBuffer, getBrandSignatureBuffer } = await import("@/lib/commercial/operating-company/assets");
    const [logo, signature] = await Promise.all([getBrandLogoBuffer(), getBrandSignatureBuffer()]);
    const { renderWorkOrderPdf } = await import("@/lib/commercial/work-orders/pdf");
    const pdf = await renderWorkOrderPdf({
      content,
      header: workOrderHeader(
        wo,
        opp,
        account,
        dealName,
        content.inclusions.length,
        allScopeCount
      ),
      company: { name: oc.name, phone: oc.phone, website: oc.website },
      logo,
      signature,
    });
    // File the frozen PDF directly (not via the void-returning auto-file helper)
    // so we get the document id back and can pin snapshot_document_id — the sent
    // WO then serves this exact copy instead of re-rendering the live proposal.
    const { uploadDocument } = await import("@/lib/commercial/documents/db");
    const up = await uploadDocument({
      parent_type: "opportunity",
      parent_id: dealId,
      category: "work_order",
      file_name: safeDocName("Work_Order", dealName) + ".pdf",
      size_bytes: pdf.length,
      mime_type: "application/pdf",
      notes: sentStampNote("Work order sent to Field Ops"),
      data: new Uint8Array(pdf),
      uploaded_by_user_id: userId,
    });
    if (up.ok) await setWorkOrderSnapshot(woId, up.document.id);
    else console.warn("[auto-file work order] upload skipped:", up.error);
    return { pdf, dealName };
  } catch (err) {
    console.warn("[auto-file work order] failed:", err);
    return null;
  }
}

/** Compose the PDF header block from the WO + deal. Exported so the download
 *  route reuses the exact same header. */
export function workOrderHeader(
  wo: { work_notes: string | null; assigned_to: string | null; scheduled_start_date: string | null; scheduled_end_date: string | null; sent_at: string | null; created_at: string; area_label?: string | null },
  opp: { title: string | null; client_name: string | null; property_street: string | null; property_city: string | null; property_state: string | null; project_number?: string | null },
  account: { company_name: string },
  dealName: string,
  /** How many scope lines are on THIS sheet, and on the project overall. */
  sheetScopeLines = 0,
  totalScopeLines = 0
) {
  const addr = [opp.property_street, [opp.property_city, opp.property_state].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" · ");
  return {
    dealName,
    // Say so when this sheet is only PART of the job. A crew handed 4 of 8
    // lines with no note can't tell a deliberate split from the whole scope —
    // so they either stop early thinking they're done, or both crews assume
    // the other had the line nobody did.
    partialScopeNote:
      totalScopeLines > 0 && sheetScopeLines > 0 && sheetScopeLines < totalScopeLines
        ? `PARTIAL SCOPE — this sheet covers ${sheetScopeLines} of ${totalScopeLines} items on this project. Work ONLY the items listed below; the rest are on separate work orders.`
        : null,
    // WO-#### plus the area tag, so a crew holding one of several sheets for
    // the same project can tell at a glance which one it is.
    recordId:
      [workOrderRecordId(opp.project_number), wo.area_label?.trim()]
        .filter(Boolean)
        .join(" · ") || null,
    gcCompany: account.company_name,
    projectAddress: addr || null,
    assignedTo: wo.assigned_to,
    scheduledStartDate: wo.scheduled_start_date,
    scheduledEndDate: wo.scheduled_end_date,
    workNotes: wo.work_notes,
    dateIso: wo.sent_at ?? wo.created_at,
  };
}

// ── Render ──────────────────────────────────────────────────────────
function Stat({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "emerald" | "blue" | "amber" }) {
  const t = tone === "emerald" ? "text-emerald-700" : tone === "blue" ? "text-ppp-blue-700" : tone === "amber" ? "text-amber-700" : "text-ppp-charcoal-800";
  return (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-surface/70 px-2.5 py-2">
      <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-lg font-black tabular-nums leading-none mt-0.5 ${t}`}>{value}</div>
    </div>
  );
}

export async function WorkOrderTool({
  id,
  dealId,
  sp,
  variant,
}: {
  id: string;
  dealId: string;
  sp: WorkOrderSP;
  variant: "route" | "inline";
}) {
  await requireUser();
  const spv = sp;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp] = await Promise.all([getCommercialAccount(id), getCommercialOpportunity(dealId)]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();

  const dealName = derivedOppName(opp, account.company_name);
  // A deal can have several work orders now (scope split across crews) — ?wo=
  // picks which sheet you're on, defaulting to the first.
  const allWorkOrders = await listWorkOrdersForOpp(dealId);
  const wo =
    (spv.wo && allWorkOrders.find((w) => w.id === spv.wo)) || allWorkOrders[0] || null;
  const [content, pickable, unassigned] = await Promise.all([
    buildWorkOrderContent(dealId, wo?.scope_line_item_ids ?? null),
    listPickableScopeForOpp(dealId),
    listUnassignedScopeForOpp(dealId),
  ]);
  const editable = wo ? isWorkOrderEditable(wo.status) : false;
  const scopeCount = content.inclusions.length;
  // Quick-links so the empty/partial hints aren't dead-ends (RUX-4): finishes
  // live on the opportunity's Finishes tab; proposals on the deal's Proposals tab.
  const finishesHref = `/commercial/opportunities/${dealId}?tab=finishes`;
  const proposalHref = `/commercial/accounts/${id}?tab=projects&project=${dealId}&dt=proposals`;

  const Ctx = () => (
    <>
      <input type="hidden" name="account_id" value={id} />
      <input type="hidden" name="opp_id" value={dealId} />
      <input type="hidden" name="back" value={spv.back ?? ""} />
      {/* Where the tool is rendered, so an action returns you here instead of
          always bouncing to the account page. */}
      <input type="hidden" name="origin" value={variant} />
      {wo && <input type="hidden" name="wo_id" value={wo.id} />}
    </>
  );

  return (
    <div className={variant === "inline" ? "space-y-4" : "max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4"}>
      {variant === "route" && (
        <>
          <ToolBackHeader accountId={id} dealId={dealId} accountName={account.company_name} dealName={dealName} back={spv.back} />
          <div>
            <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Work Order</h1>
            {/* WO-#### shares the deal's number (Karan 2026-08: "make sure the
                ending numbers are the same") so a crew member holding a work
                order can match it to the project without a lookup. */}
            <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
              {workOrderRecordId(opp.project_number) && (
                <>
                  <span className="font-mono text-ppp-navy-600" title="Work order ID — shares this project's number">
                    {workOrderRecordId(opp.project_number)}
                  </span>
                  {" · "}
                </>
              )}
              {dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span>
            </p>
          </div>
        </>
      )}

      {/* Work-order switcher. A project's scope can be split across several
          sheets — one per crew — so this is how you move between them and add
          the next one. Hidden when there's only one and nothing to split. */}
      {allWorkOrders.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {allWorkOrders.map((w, i) => {
            const label = workOrderRecordId(opp.project_number, i, allWorkOrders.length) || `Sheet ${i + 1}`;
            const active = wo?.id === w.id;
            return (
              <Link
                key={w.id}
                href={`${base(id, dealId, variant)}&wo=${w.id}${backQ(spv.back ?? "")}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-semibold min-h-[36px] touch-manipulation ${
                  active
                    ? "border-cc-brand-600 bg-cc-brand-50 text-cc-brand-800"
                    : "border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                }`}
              >
                <span className="font-mono text-[11px]">{label}</span>
                {w.area_label && <span className="font-normal">· {w.area_label}</span>}
              </Link>
            );
          })}
          <form action={createWorkOrderAction} className="inline">
            <input type="hidden" name="account_id" value={id} />
            <input type="hidden" name="opp_id" value={dealId} />
            <input type="hidden" name="origin" value={variant} />
            <input type="hidden" name="back" value={spv.back ?? ""} />
            <input type="hidden" name="another" value="1" />
            <PendingSubmitButton
              className="inline-flex items-center px-2.5 py-1.5 rounded-lg border border-dashed border-ppp-charcoal-300 text-[12px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[36px] touch-manipulation"
              pendingLabel="Adding…"
            >
              + Add another work order
            </PendingSubmitButton>
          </form>
        </div>
      )}
      {/* Nothing gets quietly dropped: splitting a job across crews is exactly
          when a line goes missing, because each sheet looks complete on its
          own. */}
      {unassigned.length > 0 && allWorkOrders.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-[12.5px] text-amber-900">
          <strong>{unassigned.length} scope line{unassigned.length === 1 ? "" : "s"} not on any work order yet.</strong>{" "}
          Tick them on a sheet below so a crew actually gets the work.
          <ul className="mt-1.5 list-disc pl-5 space-y-0.5 text-[11.5px]">
            {unassigned.slice(0, 6).map((l) => (
              <li key={l.id}>{l.label}</li>
            ))}
            {unassigned.length > 6 && <li>…and {unassigned.length - 6} more</li>}
          </ul>
        </div>
      )}
      {/* The one case seeding can't cover: a sheet added when every line is
          already assigned lands empty, and empty still prints the whole
          proposal. Say so rather than let a crew be handed everything. */}
      {wo && allWorkOrders.length > 1 && (wo.scope_line_item_ids ?? []).length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-[12.5px] text-amber-900">
          <strong>No scope picked on this sheet</strong> — it will print the
          <strong> whole proposal</strong>, including work that&rsquo;s on the other sheets.
          Tick the lines this crew should get.
        </div>
      )}
      {spv.error && <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700" role="alert">{decodeURIComponent(spv.error)}</div>}
      {spv.ok && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-[13px] text-emerald-800" role="status">
          Sent to Field Ops — it&rsquo;s now schedulable there, and the PDF was filed to this job&rsquo;s Documents
          {spv.emailed ? " and emailed to the foreman." : "."}
        </div>
      )}
      {spv.filefail && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-[13px] text-amber-800" role="status">
          Sent to Field Ops (it&rsquo;s schedulable there), but the PDF couldn&rsquo;t be generated to file or email. Re-open to edit and send again, or download it manually from below.
        </div>
      )}
      {spv.emailfail && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-[13px] text-amber-800" role="status">
          Sent + filed, but the crew email didn't go through — check the crew email address, or download the PDF above and send it manually.
        </div>
      )}

      {!wo ? (
        <div className="text-center py-12 px-4 bg-surface border border-dashed border-ppp-charcoal-200 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No work order yet</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">
            Create one to generate the crew's sheet — it autofills the scope from the accepted proposal and the room-finish schedule. You add crew notes, then send it.
          </p>
          <form action={createWorkOrderAction} className="mt-4">
            <input type="hidden" name="account_id" value={id} />
            <input type="hidden" name="opp_id" value={dealId} />
            <input type="hidden" name="back" value={spv.back ?? ""} />
            <input type="hidden" name="origin" value={variant} />
            <PendingSubmitButton className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation" pendingLabel="Creating…">
              + Create work order
            </PendingSubmitButton>
          </form>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Overview */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Status" value={WORK_ORDER_STATUS_META[wo.status].label} tone={wo.status === "sent" ? "emerald" : "neutral"} />
            <Stat label="Scope lines" value={String(scopeCount)} tone={scopeCount > 0 ? "blue" : "amber"} />
            <Stat label="Finish rows" value={String(content.finishes.length)} tone={content.finishes.length > 0 ? "blue" : "neutral"} />
            <Stat label="From proposal" value={content.proposal_revision != null ? `R${content.proposal_revision}` : "—"} tone={content.no_proposal ? "amber" : "neutral"} />
          </div>

          {/* Status controls */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full border text-[11px] font-bold uppercase tracking-wide ${
              wo.status === "sent" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : wo.status === "voided" ? "bg-rose-50 text-rose-700 border-rose-200"
              : "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200"}`}>
              {WORK_ORDER_STATUS_META[wo.status].label}
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <a
                href={
                  // A sent WO serves its FROZEN copy (what the crew received);
                  // a draft renders live so edits show in the preview.
                  wo.status === "sent" && wo.snapshot_document_id
                    ? `/api/commercial/documents/${wo.snapshot_document_id}/download`
                    : `/api/commercial/work-order/${wo.id}/pdf`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[12px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] sm:min-h-[36px]"
              >
                {wo.status === "sent" ? "View sent PDF" : "Preview PDF"}
              </a>
              {ALLOWED_WORK_ORDER_TRANSITIONS[wo.status].map((to) => (
                <form key={to} action={changeStatusAction}>
                  <Ctx />
                  <input type="hidden" name="to" value={to} />
                  <PendingSubmitButton
                    className={`inline-flex items-center px-3 py-1.5 rounded-lg text-[12px] font-semibold min-h-[44px] ${to === "voided" ? "border border-rose-300 text-rose-700 hover:bg-rose-50" : to === "draft" ? "border border-ppp-charcoal-300 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50" : "bg-cc-brand-600 text-white hover:bg-cc-brand-700"}`}
                    pendingLabel="…"
                  >
                    {to === "sent" ? "Send to Field Ops" : to === "draft" ? "Re-open to edit" : "Void"}
                  </PendingSubmitButton>
                </form>
              ))}
            </div>
          </div>

          {content.no_proposal && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-[12px] text-amber-800">
              No proposal on this job yet, so the scope section is empty. The room-finish schedule (if any) still prints. Add/accept a proposal and it fills in automatically.
            </div>
          )}

          {/* Editable crew fields (draft only) */}
          {editable ? (
            <AutosaveForm action={autosaveWorkOrderAction} formClassName="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3">
              <input type="hidden" name="account_id" value={id} />
              <input type="hidden" name="opp_id" value={dealId} />
              <input type="hidden" name="wo_id" value={wo.id} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className={LABEL_CLS}>Assigned crew / foreman</span>
                  <input type="text" name="assigned_to" defaultValue={wo.assigned_to ?? ""} placeholder="e.g. Miguel's crew" className={INPUT_CLS} />
                </label>
                <label className="block">
                  <span className={LABEL_CLS}>Crew email(s) <span className="text-ppp-charcoal-400 font-normal">· gets the PDF on send · comma-separate for more than one</span></span>
                  <input type="text" name="crew_email" defaultValue={wo.crew_email ?? ""} placeholder="foreman@…, super@…" className={INPUT_CLS} />
                </label>
                <div>
                  <span className={LABEL_CLS}>Scheduled start</span>
                  <DateField name="scheduled_start_date" defaultValue={wo.scheduled_start_date ?? ""} placeholder="Pick a start date" className="mt-1" />
                </div>
                <div>
                  <span className={LABEL_CLS}>Target finish</span>
                  <DateField name="scheduled_end_date" defaultValue={wo.scheduled_end_date ?? ""} min={wo.scheduled_start_date ?? undefined} placeholder="Pick a finish date" className="mt-1" />
                </div>
              </div>
              <label className="block">
                <span className={LABEL_CLS}>Area <span className="text-ppp-charcoal-400 font-normal">· optional, prints on the sheet</span></span>
                <input name="area_label" defaultValue={wo.area_label ?? ""} maxLength={120} placeholder='e.g. "Level 3" or "East wing"' className={INPUT_CLS} />
              </label>
              {/* Scope selection (migration 123). Untick-everything deliberately
                  means "the whole proposal" rather than an empty sheet — that's
                  also what every work order created before this existed means,
                  so legacy sheets keep printing in full. */}
              {pickable.lines.length > 0 && (
                <div>
                  <span className={LABEL_CLS}>
                    Scope on this sheet{" "}
                    <span className="text-ppp-charcoal-400 font-normal">
                      · {(wo.scope_line_item_ids ?? []).length === 0
                        ? "all of it — tick lines to split the job across crews"
                        : `${wo.scope_line_item_ids.length} of ${pickable.lines.length} lines`}
                    </span>
                  </span>
                  <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-ppp-charcoal-200 divide-y divide-ppp-charcoal-100">
                    {pickable.lines.map((l) => {
                      const checked = (wo.scope_line_item_ids ?? []).includes(l.id);
                      const onAnother =
                        !checked &&
                        allWorkOrders.some(
                          (w) => w.id !== wo.id && (w.scope_line_item_ids ?? []).includes(l.id)
                        );
                      return (
                        <label
                          key={l.id}
                          className="flex items-start gap-2 px-3 py-2 text-[12.5px] hover:bg-ppp-charcoal-50/60 cursor-pointer min-h-[44px]"
                        >
                          <input
                            type="checkbox"
                            name="scope_ids"
                            value={l.id}
                            defaultChecked={checked}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-cc-brand-600"
                          />
                          <span className="min-w-0">
                            <span className="text-ppp-charcoal">{l.label}</span>
                            {l.is_labor && <span className="ml-1.5 text-[10px] font-semibold text-ppp-blue-700">LABOR</span>}
                            {l.is_alternate && <span className="ml-1.5 text-[10px] font-semibold text-amber-700">ALT</span>}
                            {/* Say who already has it, so two crews don't get
                                handed the same line by accident. */}
                            {onAnother && (
                              <span className="ml-1.5 text-[10px] font-semibold text-ppp-charcoal-400">on another sheet</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              <label className="block">
                <span className={LABEL_CLS}>Crew notes <span className="text-ppp-charcoal-400 font-normal">· prints under the scope</span></span>
                <textarea name="work_notes" defaultValue={wo.work_notes ?? ""} rows={3} placeholder="Site access, staging, sequence, safety…" className={TEXTAREA_CLS} />
              </label>
            </AutosaveForm>
          ) : (
            <div className="bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded-lg px-4 py-2.5 text-[12px] text-ppp-charcoal-600 space-y-1.5">
              <div>
                This work order is <strong>{WORK_ORDER_STATUS_META[wo.status].label.toLowerCase()}</strong> — the crew has this copy on file. <em>Re-open to edit</em> to change it (that files a fresh copy on the next send).
              </div>
              {(wo.assigned_to || wo.scheduled_start_date || wo.scheduled_end_date || wo.crew_email) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ppp-charcoal-500 pt-0.5">
                  {wo.assigned_to && <span><span className="font-semibold text-ppp-charcoal-600">Crew:</span> {wo.assigned_to}</span>}
                  {(wo.scheduled_start_date || wo.scheduled_end_date) && (
                    <span>
                      <span className="font-semibold text-ppp-charcoal-600">Schedule:</span>{" "}
                      {wo.scheduled_start_date ? fmtEtDate(wo.scheduled_start_date) : "—"}
                      {wo.scheduled_end_date ? ` → ${fmtEtDate(wo.scheduled_end_date)}` : ""}
                    </span>
                  )}
                  {wo.crew_email && (
                    <span>
                      <span className="font-semibold text-ppp-charcoal-600">Emailed:</span>{" "}
                      {wo.crew_emailed_at ? `${wo.crew_email} · ${fmtEtDate(wo.crew_emailed_at)}` : `${wo.crew_email} (not yet)`}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Autofill preview */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-4">
            <div className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-500">What the crew sees (auto-filled)</div>

            {/* Shown in the PREVIEW too, not just the PDF — the person sending
                should see the crew's warning before they send it, not after. */}
            {pickable.lines.length > 0 &&
              (wo?.scope_line_item_ids ?? []).length > 0 &&
              (wo?.scope_line_item_ids ?? []).length < pickable.lines.length && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-900 mb-2">
                  Partial scope — this sheet covers {(wo?.scope_line_item_ids ?? []).length} of{" "}
                  {pickable.lines.length} items. The crew is told to work only what&rsquo;s listed here.
                </div>
              )}
            {content.inclusions.length > 0 && (
              <PreviewScope title="Scope of work" lines={content.inclusions} />
            )}
            {content.alternates.length > 0 && (
              <PreviewScope title="Alternates" lines={content.alternates} />
            )}
            {content.exclusions.length > 0 && (
              <div>
                <div className="text-[12px] font-bold text-ppp-charcoal mb-1">Exclusions</div>
                <ul className="text-[12.5px] text-ppp-charcoal-600 list-disc pl-5 space-y-0.5">
                  {content.exclusions.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
            {content.finishes.length > 0 ? (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="text-[12px] font-bold text-ppp-charcoal">Paint colors &amp; finishes</div>
                  <Link href={finishesHref} className="text-[11px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[36px] inline-flex items-center">Edit finishes →</Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-left text-ppp-charcoal-500 border-b border-ppp-charcoal-200">
                        <th className="py-1 pr-2 font-semibold">Code</th>
                        <th className="py-1 pr-2 font-semibold">Location</th>
                        <th className="py-1 pr-2 font-semibold">Product / Color</th>
                        <th className="py-1 pr-2 font-semibold">Sheen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {content.finishes.map((f, i) => (
                        <tr key={i} className="border-b border-ppp-charcoal-50">
                          <td className="py-1 pr-2 font-mono font-semibold">{f.code}</td>
                          <td className="py-1 pr-2">{f.location_description ?? "—"}</td>
                          <td className="py-1 pr-2">{[f.manufacturer, f.product_name, f.color].filter(Boolean).join(" · ") || "—"}</td>
                          <td className="py-1 pr-2">{f.sheen ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              // No dead-end: link straight to where finishes are added.
              <div className="text-[12px] text-ppp-charcoal-500">
                No paint colors &amp; finishes on this job yet.{" "}
                <Link href={finishesHref} className="font-semibold text-cc-brand-700 hover:text-cc-brand-800">Add finishes →</Link>{" "}
                <span className="text-ppp-charcoal-400">— they print here + on the crew PDF.</span>
              </div>
            )}
            {scopeCount === 0 && content.finishes.length === 0 && (
              // No dead-end: point at both sources that fill the sheet.
              <div className="text-[12px] text-amber-700">
                Nothing to print yet — <Link href={proposalHref} className="font-semibold underline hover:no-underline">add a proposal</Link> and/or <Link href={finishesHref} className="font-semibold underline hover:no-underline">a finish schedule</Link>.
              </div>
            )}
          </div>

          {wo.sent_at && (
            <p className="text-[11px] text-ppp-charcoal-400">Last sent to Field Ops {fmtEtDate(wo.sent_at)}. The frozen copy is in this job&rsquo;s Documents.</p>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewScope({ title, lines }: { title: string; lines: { product_name: string | null; description: string; quantity: number; unit: string; is_labor: boolean }[] }) {
  return (
    <div>
      <div className="text-[12px] font-bold text-ppp-charcoal mb-1">{title}</div>
      <ul className="text-[12.5px] text-ppp-charcoal-700 space-y-1">
        {lines.map((l, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-ppp-charcoal-400 shrink-0 w-16">{l.is_labor ? "Labor" : `${Number.isInteger(l.quantity) ? l.quantity : l.quantity.toFixed(2)} ${l.unit}`.trim()}</span>
            <span>
              {l.product_name ? <strong>{l.product_name}{l.description ? " — " : ""}</strong> : null}
              {l.description}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
