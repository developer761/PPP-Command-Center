import Link from "next/link";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { SubmitButton } from "@/components/commercial/submit-button";
import {
  formatSignedAt,
  SIGNATURE_STATUS_LABEL,
  SIGNATURE_STATUS_TONE,
} from "@/lib/commercial/esign/constants";
import type { SignatureEvent, SignatureRequest } from "@/lib/commercial/esign/db";

/**
 * The proposal page's e-signature card: where the signature stands, the one
 * action that moves it (countersign), the documents it produced, and the trail.
 *
 * Shows the request that matters — the signed one if there is one, else the
 * newest — up front; older links (re-sends, voided, expired) fold under it so a
 * proposal emailed four times doesn't open with four cards.
 */

type Action = (formData: FormData) => void | Promise<void>;

export const REFILE_AFTER_MS = 3 * 60_000;

/** Completed, still no signed copy, and long enough past the countersign that
 *  the first filing has finished rather than being mid-render. Server-rendered
 *  per request, so reading the clock here is the point. */
export function refileReady(r: Pick<SignatureRequest, "status" | "signed_document_id" | "countersigned_at">, now = Date.now()): boolean {
  return (
    r.status === "completed" &&
    !r.signed_document_id &&
    !!r.countersigned_at &&
    now - Date.parse(r.countersigned_at) > REFILE_AFTER_MS
  );
}

const TONE_CHIP: Record<"green" | "amber" | "grey" | "red", string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  grey: "bg-ppp-charcoal-50 text-ppp-charcoal-700 ring-ppp-charcoal-200",
  red: "bg-rose-50 text-rose-800 ring-rose-200",
};

export function ProposalSignaturePanel(props: {
  requests: Array<SignatureRequest & { events: SignatureEvent[] }>;
  hiddenIds: React.ReactNode;
  viewerIsApprover: boolean;
  hasCompanySignature: boolean;
  countersignAs: string;
  /** Non-null when the proposal has moved on and Countersign would be refused. */
  countersignBlocked: string | null;
  countersignAction: Action;
  voidAction: Action;
  refileAction: Action;
}) {
  if (props.requests.length === 0) return null;
  const primary =
    props.requests.find((r) => r.status === "awaiting_countersign" || r.status === "completed") ?? props.requests[0];
  const others = props.requests.filter((r) => r.id !== primary.id);

  return (
    <section id="signature" className="scroll-mt-24 rounded-xl border border-ppp-charcoal-200 bg-surface shadow-sm">
      <div className="flex items-start justify-between gap-3 rounded-t-xl border-b border-ppp-charcoal-100 bg-ppp-charcoal-50/40 px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-[13px] font-bold leading-tight text-ppp-charcoal">E-signature</h2>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ppp-charcoal-500">
            The customer signs online first, then an approver countersigns. Every step is on the audit trail.
          </p>
        </div>
        <Link href="/commercial/reports/signatures" className="shrink-0 text-[12px] font-semibold text-cc-brand-700 hover:underline">
          All signatures →
        </Link>
      </div>

      <div className="p-4 sm:p-5">
        <RequestBlock {...props} request={primary} />
        {others.length > 0 ? (
          <details className="mt-4 border-t border-ppp-charcoal-100 pt-3">
            <summary className="cursor-pointer text-[12.5px] font-semibold text-ppp-charcoal-600 min-h-[36px] flex items-center">
              Other signing links ({others.length})
            </summary>
            <div className="mt-3 space-y-4">
              {others.map((r) => (
                <div key={r.id} className="rounded-lg border border-ppp-charcoal-100 p-3">
                  <RequestBlock {...props} request={r} compact />
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function RequestBlock(props: {
  request: SignatureRequest & { events: SignatureEvent[] };
  hiddenIds: React.ReactNode;
  viewerIsApprover: boolean;
  hasCompanySignature: boolean;
  countersignAs: string;
  /** Non-null when the proposal has moved on and Countersign would be refused. */
  countersignBlocked: string | null;
  countersignAction: Action;
  voidAction: Action;
  refileAction: Action;
  compact?: boolean;
}) {
  const r = props.request;
  const tone = SIGNATURE_STATUS_TONE[r.status];
  // Anyone can pull back an unanswered link; a customer's signature is voided
  // only by someone with the authority to have countersigned it.
  const canVoid = r.status === "awaiting_customer" || (r.status === "awaiting_countersign" && props.viewerIsApprover);
  // The filing runs right after countersigning, so for a few minutes "no signed
  // copy yet" means "still rendering" — offering a retry then files it twice.
  const needsRefile = refileReady(r);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-1 ring-inset ${TONE_CHIP[tone]}`}>
          {SIGNATURE_STATUS_LABEL[r.status]}
        </span>
        <span className="text-[12.5px] text-ppp-charcoal-600">
          Sent to <strong className="font-semibold text-ppp-charcoal">{r.signer_email}</strong> · {formatSignedAt(r.created_at)}
        </span>
      </div>

      {/* Progress: 1/2 customer, 2/2 us. Green done, amber waiting, grey not yet. */}
      {!props.compact ? (
        <ol className="mt-3 grid gap-2 sm:grid-cols-2">
          <Step
            n={1}
            label="Customer"
            state={r.customer_signed_at ? "done" : r.status === "awaiting_customer" ? "current" : "idle"}
            detail={
              r.customer_signed_at
                ? `${r.customer_name}${r.customer_title ? `, ${r.customer_title}` : ""}${r.customer_company ? ` · ${r.customer_company}` : ""} — ${formatSignedAt(r.customer_signed_at)}`
                : r.status === "awaiting_customer"
                  ? `Waiting · link open until ${formatSignedAt(r.expires_at)}`
                  : "Not signed"
            }
          />
          <Step
            n={2}
            label="Countersignature"
            state={r.countersigned_at ? "done" : r.status === "awaiting_countersign" ? "current" : "idle"}
            detail={
              r.countersigned_at
                ? `${r.countersigner_name}${r.countersigner_title ? `, ${r.countersigner_title}` : ""} — ${formatSignedAt(r.countersigned_at)}`
                : r.status === "awaiting_countersign"
                  ? "Waiting on an approver"
                  : "After the customer signs"
            }
          />
        </ol>
      ) : null}

      {r.status === "declined" ? (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800">
          Declined {formatSignedAt(r.declined_at)}{r.decline_reason ? `: “${r.decline_reason}”` : " — no reason given."}
        </p>
      ) : null}
      {r.status === "voided" && r.void_reason ? (
        <p className="mt-3 text-[12.5px] text-ppp-charcoal-600">Voided: {r.void_reason}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {r.status === "awaiting_countersign" && props.countersignBlocked ? (
          <p className="w-full rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">{props.countersignBlocked}</p>
        ) : null}
        {r.status === "awaiting_countersign" && !props.countersignBlocked && props.viewerIsApprover && props.hasCompanySignature ? (
          <form action={props.countersignAction} className="inline-flex">
            {props.hiddenIds}
            <input type="hidden" name="signature_request_id" value={r.id} />
            <ConfirmSubmitButton
              message={`Countersign as ${props.countersignAs}? The signature on file is applied and recorded as applied by you. The signed contract and audit trail file to this deal, the customer is emailed their copy, and a sent proposal is marked won.`}
              pendingLabel="Countersigning…"
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-emerald-700 touch-manipulation"
            >
              Countersign
            </ConfirmSubmitButton>
          </form>
        ) : null}
        {r.status === "awaiting_countersign" && !props.countersignBlocked && props.viewerIsApprover && !props.hasCompanySignature ? (
          <Link href="/commercial/settings/operating-company" className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-300 bg-amber-50 px-3 text-[13px] font-semibold text-amber-900">
            Add a signature on file to countersign →
          </Link>
        ) : null}
        {r.status === "awaiting_countersign" && !props.countersignBlocked && !props.viewerIsApprover ? (
          <span className="text-[12.5px] text-ppp-charcoal-600">An approver needs to countersign.</span>
        ) : null}
        {needsRefile ? (
          <form action={props.refileAction} className="inline-flex">
            {props.hiddenIds}
            <input type="hidden" name="signature_request_id" value={r.id} />
            <SubmitButton pendingLabel="Filing…" className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-300 bg-amber-50 px-3 text-[13px] font-semibold text-amber-900">
              The signed copy didn&rsquo;t file — try again
            </SubmitButton>
          </form>
        ) : null}
        {r.signed_document_id ? (
          <a href={`/api/commercial/signatures/${r.id}/signed`} target="_blank" rel="noopener" className="inline-flex min-h-[44px] items-center rounded-lg border border-ppp-charcoal-200 bg-surface px-3 text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50">
            Signed copy (PDF)
          </a>
        ) : null}
        {r.events.length > 0 ? (
          <a href={`/api/commercial/signatures/${r.id}/audit`} target="_blank" rel="noopener" className="inline-flex min-h-[44px] items-center rounded-lg border border-ppp-charcoal-200 bg-surface px-3 text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50">
            Audit trail (PDF)
          </a>
        ) : null}
      </div>

      {r.events.length > 0 ? (
        <details className="mt-3">
          <summary className="flex min-h-[36px] cursor-pointer items-center text-[12.5px] font-semibold text-ppp-charcoal-600">
            Activity ({r.events.length})
          </summary>
          <ol className="mt-2 space-y-2 border-l-2 border-ppp-charcoal-100 pl-3">
            {r.events.map((e) => (
              <li key={e.id} className="text-[12px] leading-snug">
                <span className="font-semibold text-ppp-charcoal">{e.type}</span>{" "}
                <span className="text-ppp-charcoal-500">{formatSignedAt(e.at)}</span>
                <p className="mt-0.5 break-words text-ppp-charcoal-600">{e.details}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {canVoid ? (
        <details className="mt-2">
          <summary className="flex min-h-[36px] cursor-pointer items-center text-[12px] font-medium text-ppp-charcoal-500">Void this signature request</summary>
          <form action={props.voidAction} className="mt-2 space-y-2">
            {props.hiddenIds}
            <input type="hidden" name="signature_request_id" value={r.id} />
            <label htmlFor={`void-${r.id}`} className="block text-[12px] font-semibold text-ppp-charcoal-700">
              Why? (goes on the audit trail)
            </label>
            <textarea
              id={`void-${r.id}`}
              name="reason"
              required
              maxLength={1000}
              rows={2}
              className="w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2 text-base text-ppp-charcoal outline-none focus:border-cc-brand-500 sm:text-[13px]"
              placeholder="e.g. Sent to the wrong contact"
            />
            <SubmitButton pendingLabel="Voiding…" className="inline-flex min-h-[44px] items-center rounded-lg border border-rose-300 bg-surface px-3 text-[13px] font-semibold text-rose-700 hover:bg-rose-50">
              Void the link
            </SubmitButton>
          </form>
        </details>
      ) : null}
    </div>
  );
}

function Step({ n, label, state, detail }: { n: number; label: string; state: "done" | "current" | "idle"; detail: string }) {
  const dot =
    state === "done"
      ? "bg-emerald-600 text-white"
      : state === "current"
        ? "bg-amber-500 text-white ring-2 ring-amber-200"
        : "bg-ppp-charcoal-200 text-ppp-charcoal-600";
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-ppp-charcoal-100 p-2.5">
      <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${dot}`} aria-hidden>
        {state === "done" ? "✓" : n}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-ppp-charcoal">
          {label} <span className="font-normal text-ppp-charcoal-500">· {n}/2</span>
        </span>
        <span className="block break-words text-[12px] text-ppp-charcoal-600">{detail}</span>
      </span>
    </li>
  );
}
