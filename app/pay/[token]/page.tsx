import { notFound } from "next/navigation";
import { canOpenPayPages, getSignedInAdminEmail } from "@/lib/payments/access";
import { loadPayState, paymentsConfig } from "@/lib/payments/service";
import { cardFeeCents, formatCents, type Milestone } from "@/lib/payments/schedule";
import { PayMessage, PayShell } from "@/components/pay/pay-shell";
import { PPP_BRAND } from "@/lib/brand";
import { surchargeAllowedIn } from "@/lib/payments/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay your invoice · Precision Painting Plus", robots: { index: false } };

/**
 * /pay/<token> — the customer's invoice payment page.
 *
 * Every amount on this page is computed on the server from Salesforce as of
 * this request. The buttons carry only WHICH milestone and WHICH method; the
 * checkout route recomputes the amount itself, so nothing the browser sends
 * can change what is charged.
 *
 * Admin-only until PAYMENTS_PUBLIC=1 (see lib/payments/access.ts).
 */
export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const { token } = await params;
  const { err } = await searchParams;
  const errText = err ? (ERROR_COPY[err] ?? ERROR_COPY.failed) : null;
  // Not "sign in to continue": until go-live the page does not exist for
  // anyone but an admin, and should look that way.
  if (!(await canOpenPayPages())) notFound();

  const cfg = paymentsConfig();
  const isAdmin = (await getSignedInAdminEmail()) != null;
  const previewNote = !cfg.publicPages
    ? `${cfg.sfOrg === "sandbox" ? "SALESFORCE SANDBOX · " : ""}Admin preview — customers can't open this page yet.${cfg.stripeMode === "test" ? " Stripe TEST mode: use card 4242 4242 4242 4242." : ""}`
    : cfg.stripeMode === "test" && isAdmin
      ? "Stripe TEST mode — no real money moves."
      : null;

  const state = await loadPayState(token);

  if (state.kind === "not_found") {
    return (
      <PayShell previewNote={previewNote}>
        <PayMessage
          tone="warn"
          heading="This payment link isn't valid"
          body={`Please call Precision Painting Plus at ${PPP_BRAND.contact.phone} and we'll send you a new one.`}
        />
      </PayShell>
    );
  }
  if (state.kind === "revoked" || state.kind === "closed") {
    return (
      <PayShell previewNote={previewNote}>
        <PayMessage
          tone="warn"
          heading="Online payment is closed for this job"
          body={`Please call Precision Painting Plus at ${PPP_BRAND.contact.phone} about this invoice.`}
        />
      </PayShell>
    );
  }

  const { wo, schedule } = state;
  const due = schedule.milestones.find((m) => m.status === "due") ?? null;
  const showFullBalance = due != null && schedule.payableBalanceCents > due.remainingCents;
  const address = [wo.street, [wo.city, wo.state].filter(Boolean).join(", "), wo.postalCode]
    .filter(Boolean)
    .join(" ");
  const nothingOwed = schedule.payableBalanceCents <= 0;
  // No credit-card fee where the law doesn't allow one (CT / MA / ME).
  const surcharge = surchargeAllowedIn(wo.state, cfg);
  // "30% deposit · 50% progress · 20% final" — only when every term is a
  // percentage; a mix with dollar-amount terms would read as a sum that's off.
  const terms = schedule.milestones.filter((m) => m.key !== "extra");
  const scheduleSummary =
    terms.length > 1 && terms.every((m) => m.percent != null)
      ? terms.map((m) => `${m.percent}% ${m.label.toLowerCase()}`).join(" · ")
      : null;

  return (
    <PayShell previewNote={previewNote}>
      <div className="space-y-5">
        <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6">
          <div className="text-[11px] font-condensed uppercase tracking-[0.16em] text-ppp-charcoal-500">
            Invoice {wo.number}
          </div>
          {wo.contactName && <h1 className="mt-1 text-xl sm:text-2xl font-bold text-ppp-navy">{wo.contactName}</h1>}
          {address && <p className="text-[13px] text-ppp-charcoal-600 mt-0.5">{address}</p>}
          <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-ppp-charcoal-100 pt-4">
            <span className="text-sm text-ppp-charcoal-600">Remaining balance</span>
            <span className="text-2xl font-condensed font-bold text-ppp-navy tabular-nums">
              {formatCents(schedule.payableBalanceCents)}
            </span>
          </div>
          {schedule.inFlightCents > 0 && (
            <p className="mt-2 text-[12px] text-ppp-charcoal-600">
              You&rsquo;ve already paid {formatCents(schedule.inFlightCents)} online that&rsquo;s still being processed —
              it&rsquo;s been taken off the balance above.
            </p>
          )}
        </section>

        {errText && (
          <div role="alert" className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 text-[13px] text-ppp-orange-700">
            {errText}
          </div>
        )}

        {isAdmin && schedule.warnings.length > 0 && (
          <div className="rounded-xl border border-ppp-charcoal-200 bg-white px-4 py-3 text-[12px] text-ppp-charcoal-700">
            <div className="font-semibold text-ppp-navy mb-1">Admin only — check before this goes to customers</div>
            <ul className="list-disc pl-4 space-y-0.5">
              {schedule.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {nothingOwed ? (
          <PayMessage tone="ok" heading="You're all paid up" body="Thank you — there's nothing left to pay on this invoice." />
        ) : (
          <section className="bg-white border border-ppp-charcoal-100 rounded-2xl divide-y divide-ppp-charcoal-100">
            <div className="px-5 sm:px-6 py-4">
              <h2 className="text-sm font-bold text-ppp-navy">Payment schedule</h2>
              {scheduleSummary && <p className="text-[12px] text-ppp-charcoal-600 mt-0.5">{scheduleSummary}</p>}
            </div>
            {schedule.milestones.map((m) => (
              <MilestoneRow key={m.key} m={m} token={token} surcharge={surcharge} />
            ))}
          </section>
        )}

        {showFullBalance && (
          <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6">
            <h2 className="text-sm font-bold text-ppp-navy">Or pay the full balance now</h2>
            <PayButtons token={token} milestoneKey="balance" baseCents={schedule.payableBalanceCents} surcharge={surcharge} />
          </section>
        )}

        {/* The fee disclosure only matters while something is owed. */}
        {!nothingOwed && (
          <p className="text-[12px] leading-relaxed text-ppp-charcoal-600 px-1">
            {surcharge
              ? "Credit card payments include a 3.00% service fee, which does not exceed our cost of accepting the card. Debit card and bank transfer (ACH) payments have no fee."
              : "Card and bank transfer (ACH) payments have no service fee."}
          </p>
        )}
      </div>
    </PayShell>
  );
}

const ERROR_COPY: Record<string, string> = {
  not_due: "That amount isn't due right now — the page has been updated with what is.",
  inactive: `This payment link is no longer active. Please call ${PPP_BRAND.contact.phone}.`,
  no_method: "Please choose how you'd like to pay.",
  unavailable: `Online payment isn't available right now. Please try again later or call ${PPP_BRAND.contact.phone}.`,
  failed: `We couldn't start the payment just now. Please try again in a minute, or call ${PPP_BRAND.contact.phone}.`,
};

const STATUS_CHIP: Record<Milestone["status"], { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100" },
  processing: { label: "Processing", cls: "bg-ppp-blue-50 text-ppp-blue-800 border-ppp-blue-200" },
  due: { label: "Due now", cls: "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100" },
  upcoming: { label: "Upcoming", cls: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200" },
};

function MilestoneRow({ m, token, surcharge }: { m: Milestone; token: string; surcharge: boolean }) {
  const chip = STATUS_CHIP[m.status];
  const shownCents = m.status === "paid" || m.status === "processing" ? m.amountCents : m.remainingCents;
  return (
    <div className="px-5 sm:px-6 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ppp-navy">{m.label}</div>
          {m.percent != null && (
            <div className="text-[12px] text-ppp-charcoal-600">{m.percent}% of the job</div>
          )}
          {m.partlyPaid && (
            <div className="text-[12px] text-ppp-charcoal-600">
              {formatCents(m.amountCents - m.remainingCents)} of {formatCents(m.amountCents)} already paid
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-condensed font-bold text-ppp-navy tabular-nums">{formatCents(shownCents)}</span>
          <span className={`text-[11px] font-semibold border rounded-full px-2 py-0.5 ${chip.cls}`}>{chip.label}</span>
        </div>
      </div>
      {m.status === "due" && <PayButtons token={token} milestoneKey={m.key} baseCents={m.remainingCents} surcharge={surcharge} />}
    </div>
  );
}

/**
 * Two buttons, two amounts, and the method is locked by which one you press.
 * The amounts here are for reading only — the checkout route recomputes them.
 */
function PayButtons({
  token,
  milestoneKey,
  baseCents,
  surcharge,
}: {
  token: string;
  milestoneKey: string;
  baseCents: number;
  surcharge: boolean;
}) {
  const cardTotal = baseCents + cardFeeCents(baseCents);
  return (
    <form method="post" action={`/pay/${token}/checkout`} className="mt-3 grid gap-2 sm:grid-cols-2">
      <input type="hidden" name="milestone" value={milestoneKey} />
      <button
        type="submit"
        name="method"
        value="ach"
        className="rounded-xl bg-ppp-navy text-white px-4 py-3 text-left hover:bg-ppp-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ppp-navy"
      >
        <span className="block text-[12px] opacity-90">Pay by bank (ACH) · no fee</span>
        <span className="block text-lg font-condensed font-bold tabular-nums">{formatCents(baseCents)}</span>
      </button>
      <button
        type="submit"
        name="method"
        value="card"
        className="rounded-xl border border-ppp-charcoal-300 bg-white text-ppp-navy px-4 py-3 text-left hover:bg-ppp-charcoal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ppp-navy"
      >
        {surcharge ? (
          <>
            <span className="block text-[12px] text-ppp-charcoal-600">Pay by card</span>
            <span className="block text-[13px] text-ppp-navy tabular-nums">
              Debit <span className="font-condensed font-bold text-lg">{formatCents(baseCents)}</span>
            </span>
            <span className="block text-[12px] text-ppp-charcoal-600 tabular-nums">Credit {formatCents(cardTotal)} (incl. 3%)</span>
          </>
        ) : (
          <>
            <span className="block text-[12px] text-ppp-charcoal-600">Pay by card · no fee</span>
            <span className="block text-lg font-condensed font-bold tabular-nums">{formatCents(baseCents)}</span>
          </>
        )}
      </button>
    </form>
  );
}
