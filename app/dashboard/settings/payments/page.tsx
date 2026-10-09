import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import PageHeader from "@/components/page-header";
import { getSignedInAdminEmail } from "@/lib/payments/access";
import {
  createLinksForOpenWorkOrders,
  issuePaymentLinkAndPublish,
  listRecentLinks,
  listRecentPayments,
  paymentsConfig,
  retrySalesforceWrite,
  revokePaymentLink,
  type PaymentLinkRow,
  type PaymentRow,
} from "@/lib/payments/service";
import { formatCents } from "@/lib/payments/schedule";
import { shouldWriteToSalesforce } from "@/lib/payments/config";
import { getWorkOrderPaymentStateByNumber } from "@/lib/salesforce/payments";
import { relativeAgoEt } from "@/lib/date-et";

export const dynamic = "force-dynamic";
// "Create links for open Work Orders" writes up to 100 links to Salesforce.
export const maxDuration = 60;

/**
 * Settings → Online Payments. The admin side of /pay/<token>:
 *   - what is switched on (Stripe key mode, webhook, public pages, SF write-back)
 *   - make a pay link for a Work Order
 *   - every checkout opened, what Stripe said, and the exact Transaction__c it
 *     wrote to Salesforce — or, in a dry run, WOULD have written.
 */

const PATH = "/dashboard/settings/payments";
const MIGRATION = "supabase/migrations/20260923160000_stripe_payments.sql";

async function requireAdmin(): Promise<string> {
  const email = await getSignedInAdminEmail();
  if (!email) redirect("/dashboard");
  return email;
}

async function createLinkAction(formData: FormData) {
  "use server";
  const email = await requireAdmin();
  const raw = String(formData.get("wo") ?? "").trim();
  let msg: string;
  let ok = false;
  try {
    const wo = await getWorkOrderPaymentStateByNumber(raw);
    if (!wo) msg = `No Work Order "${raw}" in Salesforce. Use the 8-digit number on the invoice, e.g. 00313399.`;
    else {
      const r = await issuePaymentLinkAndPublish({ id: wo.id, number: wo.number, state: wo.state }, email);
      msg = `Pay link ready for WO ${wo.number}: ${r.url} — ${
        r.salesforce.ok ? "saved to the Work Order in Salesforce" : `NOT saved to Salesforce (${r.salesforce.reason})`
      }`;
      ok = true;
    }
  } catch (err) {
    msg = `Couldn't create the link: ${err instanceof Error ? err.message : String(err)}`;
  }
  revalidatePath(PATH);
  redirect(`${PATH}?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}

async function revokeLinkAction(formData: FormData) {
  "use server";
  await requireAdmin();
  const token = String(formData.get("token") ?? "");
  let msg = "Link switched off. Anyone opening it is told to call the office.";
  let ok = true;
  try {
    const r = await revokePaymentLink(token);
    msg += r.salesforce.ok
      ? " Removed from the Work Order, so the next invoice shows the old Stripe link."
      : ` Couldn't clear it in Salesforce (${r.salesforce.reason}).`;
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
    ok = false;
  }
  revalidatePath(PATH);
  redirect(`${PATH}?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}

async function bulkLinksAction() {
  "use server";
  const email = await requireAdmin();
  let msg: string;
  let ok = false;
  try {
    const r = await createLinksForOpenWorkOrders(email, 100);
    msg =
      r.found === 0
        ? "Every open Work Order with money owed already has a pay link."
        : `${r.found} open Work Order${r.found === 1 ? "" : "s"} found · ${r.published} link${r.published === 1 ? "" : "s"} saved to Salesforce` +
          (r.failed.length ? ` · ${r.failed.length} not saved (e.g. WO ${r.failed[0].number}: ${r.failed[0].reason})` : "") +
          (r.found === 100 ? " · run again for more." : "") +
          (r.licenseeFilter === "unavailable"
            ? " · NOTE: licensee jobs couldn't be excluded — the Command Center can't read the User licensee flags (ask Katie for read access)."
            : "");
    ok = r.failed.length === 0;
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  revalidatePath(PATH);
  redirect(`${PATH}?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}

async function retryWriteAction(formData: FormData) {
  "use server";
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  let msg: string;
  let ok = false;
  try {
    const p = await retrySalesforceWrite(id);
    msg = `WO ${p.work_order_number}: ${p.sf_writeback_status} — ${p.sf_writeback_detail ?? ""}`;
    ok = p.sf_writeback_status !== "failed";
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  revalidatePath(PATH);
  redirect(`${PATH}?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
}

export default async function PaymentsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { ok, err } = await searchParams;
  const cfg = paymentsConfig();

  let links: PaymentLinkRow[] = [];
  let payments: PaymentRow[] = [];
  let tablesMissing = false;
  let loadError: string | null = null;
  try {
    [links, payments] = await Promise.all([listRecentLinks(), listRecentPayments()]);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/does not exist|schema cache|PGRST205|42P01/i.test(m)) tablesMissing = true;
    else loadError = m;
  }

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title="Online Payments"
        subtitle="Stripe pay links for invoices. Each milestone at a fixed amount; card or ACH locked by the button; the 3% fee only on card."
      />

      {ok && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 break-words">{ok}</div>
      )}
      {err && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 break-words">
          {err}
        </div>
      )}
      {tablesMissing && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The payments tables don&rsquo;t exist yet. Paste <code className="font-mono text-[12px]">{MIGRATION}</code> into the
          Supabase SQL editor and run it.
        </div>
      )}
      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{loadError}</div>
      )}

      <section className="rounded-xl bg-white border border-ppp-charcoal-100 p-5">
        <h2 className="text-base font-semibold text-ppp-charcoal mb-3">Switches</h2>
        <dl className="grid gap-3 sm:grid-cols-2 text-sm">
          <Switch
            label="Stripe key"
            state={cfg.stripeBlockedReason ? "bad" : cfg.stripeMode === "test" ? "test" : "on"}
            value={cfg.stripeBlockedReason ?? (cfg.stripeMode === "test" ? "Test mode — no real money" : "LIVE — real money")}
            env="STRIPE_SECRET_KEY"
          />
          <Switch
            label="Card form key"
            state={cfg.cardBlockedReason ? "bad" : cfg.stripeMode === "test" ? "test" : "on"}
            value={cfg.cardBlockedReason ?? "Set — card payments charge 3% on credit cards only"}
            env="NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
          />
          <Switch
            label="Webhook"
            state={cfg.webhookSecretPresent ? "on" : "bad"}
            value={cfg.webhookSecretPresent ? "Signing secret set" : "Not set — payments still sync from the thank-you page, but ACH clearing and refunds won't"}
            env="STRIPE_WEBHOOK_SECRET"
          />
          <Switch
            label="Customer access"
            state={cfg.publicPages ? "on" : "off"}
            value={cfg.publicPages ? "PUBLIC — customers can open pay links" : "Admins only — nothing is customer-facing"}
            env="PAYMENTS_PUBLIC=1"
          />
          <Switch
            label="Salesforce org"
            state={cfg.sfOrg === "sandbox" ? "test" : "on"}
            value={
              cfg.sfOrg === "sandbox"
                ? "SANDBOX — payment links, Payment Ins and Payment Terms go to the sandbox. The rest of the Command Center stays on production."
                : "Production"
            }
            env="PAYMENTS_SF_ORG"
          />
          <Switch
            label="Salesforce write-back"
            state={cfg.sfWritebackOn ? "on" : "off"}
            value={
              cfg.sfWritebackOn
                ? "On for LIVE payments, once each clears in a Stripe payout (test payments are never written)"
                : "Dry run — the Transaction__c is built and shown below, not sent"
            }
            env="PAYMENTS_SF_WRITEBACK=on"
          />
        </dl>
      </section>

      <section className="rounded-xl bg-white border border-ppp-charcoal-100 p-5">
        <h2 className="text-base font-semibold text-ppp-charcoal">Make a pay link</h2>
        <p className="text-sm text-ppp-charcoal-500 mt-1">
          Enter the Work Order number from the invoice. A Work Order has one link; asking again gives back the same one.
        </p>
        <form action={createLinkAction} className="mt-3 flex flex-col sm:flex-row gap-2">
          <label htmlFor="wo" className="sr-only">
            Work Order number
          </label>
          <input
            id="wo"
            name="wo"
            required
            inputMode="numeric"
            placeholder="00313399"
            className="flex-1 min-w-0 rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-sm min-h-[44px]"
          />
          <button type="submit" className="rounded-lg bg-ppp-navy text-white px-4 py-2 text-sm font-semibold min-h-[44px]">
            Create link
          </button>
        </form>
        <form action={bulkLinksAction} className="mt-3">
          <button
            type="submit"
            className="rounded-lg border border-ppp-charcoal-200 px-4 py-2 text-sm font-semibold text-ppp-navy min-h-[44px]"
          >
            Create links for open Work Orders
          </button>
          <span className="ml-2 text-[12px] text-ppp-charcoal-500">
            Money owed, payment terms set, no link yet, not a licensee job. Up to 100 per click.
          </span>
        </form>
        {cfg.sfOrg === "sandbox" && (
          <p className="mt-3 text-[12px] text-ppp-charcoal-600">
            Sandbox mode.{" "}
            <a href="/api/auth/salesforce-sandbox/login" className="font-semibold text-ppp-navy underline underline-offset-2">
              Connect (or reconnect) the sandbox
            </a>{" "}
            — sign in with your sandbox user.
          </p>
        )}
        {cfg.stripeMode === "test" && (
          <p className="mt-3 text-[12px] text-ppp-charcoal-500">
            Testing: credit card <span className="font-mono">4242 4242 4242 4242</span>, debit card{" "}
            <span className="font-mono">4000 0566 5566 5556</span>, any future date, any CVC. ACH: pick
            &ldquo;Test Institution&rdquo; in the bank step — the success account clears; the failure account bounces.
          </p>
        )}
      </section>

      <section className="rounded-xl bg-white border border-ppp-charcoal-100">
        <h2 className="text-base font-semibold text-ppp-charcoal px-5 pt-5 pb-3">Links</h2>
        {links.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-ppp-charcoal-500">No pay links yet.</p>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {links.map((l) => (
              <li key={l.token} className="px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-ppp-charcoal">
                    WO {l.work_order_number}
                    {l.revoked_at && <span className="ml-2 text-[11px] font-semibold text-red-700">switched off</span>}
                  </div>
                  <div className="text-[12px] text-ppp-charcoal-500 break-all font-mono">/pay/{l.token}</div>
                  <div className="text-[11px] text-ppp-charcoal-500">
                    {l.created_by ?? "—"} · {relativeAgoEt(l.created_at)}
                  </div>
                </div>
                {!l.revoked_at && (
                  <div className="flex gap-2 shrink-0">
                    <Link
                      href={`/pay/${l.token}`}
                      target="_blank"
                      className="rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-[13px] font-semibold text-ppp-navy min-h-[44px] inline-flex items-center"
                    >
                      Open pay page
                    </Link>
                    <form action={revokeLinkAction}>
                      <input type="hidden" name="token" value={l.token} />
                      <button
                        type="submit"
                        className="rounded-lg border border-red-200 px-3 py-2 text-[13px] font-semibold text-red-700 min-h-[44px]"
                      >
                        Switch off
                      </button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl bg-white border border-ppp-charcoal-100">
        <h2 className="text-base font-semibold text-ppp-charcoal px-5 pt-5 pb-3">Payments</h2>
        {payments.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-ppp-charcoal-500">No checkouts opened yet.</p>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {payments.map((p) => (
              <PaymentItem key={p.id} p={p} canRetry={shouldWriteToSalesforce(cfg, p.livemode)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Switch({ label, state, value, env }: { label: string; state: "on" | "off" | "test" | "bad"; value: string; env: string }) {
  const dot = { on: "bg-emerald-500", test: "bg-sky-500", off: "bg-ppp-charcoal-300", bad: "bg-red-500" }[state];
  return (
    <div className="rounded-lg border border-ppp-charcoal-100 px-3 py-2">
      <dt className="flex items-center gap-2 font-semibold text-ppp-charcoal">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
        {label}
      </dt>
      <dd className="text-ppp-charcoal-600 text-[13px] mt-0.5">{value}</dd>
      <dd className="text-[11px] font-mono text-ppp-charcoal-400 mt-0.5">{env}</dd>
    </div>
  );
}

const STATUS_CLS: Record<string, string> = {
  succeeded: "text-emerald-800 bg-emerald-50 border-emerald-200",
  processing: "text-sky-800 bg-sky-50 border-sky-200",
  open: "text-ppp-charcoal-700 bg-ppp-charcoal-50 border-ppp-charcoal-200",
  expired: "text-ppp-charcoal-600 bg-white border-ppp-charcoal-200",
  failed: "text-red-800 bg-red-50 border-red-200",
  refunded: "text-amber-800 bg-amber-50 border-amber-200",
};

function PaymentItem({ p, canRetry }: { p: PaymentRow; canRetry: boolean }) {
  return (
    <li className="px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-ppp-charcoal">WO {p.work_order_number}</span>
        <span className="text-ppp-charcoal-600">{p.milestone_label}</span>
        <span className="text-ppp-charcoal-600">
          {p.method === "card" ? `Card${p.card_funding ? ` (${p.card_funding})` : ""}` : "ACH"}
        </span>
        <span className={`text-[11px] font-semibold border rounded-full px-2 py-0.5 ${STATUS_CLS[p.status] ?? ""}`}>{p.status}</span>
        {!p.livemode && <span className="text-[11px] font-semibold text-sky-700">TEST</span>}
        <span className="ml-auto text-[11px] text-ppp-charcoal-500">{relativeAgoEt(p.created_at)}</span>
      </div>
      <div className="mt-1 text-[13px] text-ppp-charcoal-700 tabular-nums">
        {formatCents(p.total_cents)} charged
        {p.fee_cents > 0 && (
          <span className="text-ppp-charcoal-500">
            {" "}
            = {formatCents(p.base_cents)} toward the balance + {formatCents(p.fee_cents)} card fee
          </span>
        )}
      </div>
      {p.status === "succeeded" && !p.sf_writeback_status && (
        <div className="mt-2 text-[12px] text-ppp-charcoal-600">
          Salesforce: <span className="font-semibold">waiting for the Stripe payout</span> — booked automatically once the
          money clears.
          {canRetry && (
            <form action={retryWriteAction} className="mt-2">
              <input type="hidden" name="id" value={p.id} />
              <button type="submit" className="rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-[12px] font-semibold min-h-[44px]">
                Book in Salesforce now
              </button>
            </form>
          )}
        </div>
      )}
      {p.sf_writeback_status && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] font-semibold text-ppp-navy">
            Salesforce: {p.sf_writeback_status === "dry_run" ? "dry run (not sent)" : p.sf_writeback_status}
            {p.sf_transaction_id ? ` · ${p.sf_transaction_id}` : ""}
          </summary>
          <p className="mt-1 text-[12px] text-ppp-charcoal-600">{p.sf_writeback_detail}</p>
          {p.sf_payload && (
            <pre className="mt-1 text-[11px] bg-ppp-charcoal-50 rounded-lg p-3 overflow-x-auto">
              {JSON.stringify(p.sf_payload, null, 2)}
            </pre>
          )}
          {canRetry && p.status === "succeeded" && p.sf_writeback_status !== "written" && (
            <form action={retryWriteAction} className="mt-2">
              <input type="hidden" name="id" value={p.id} />
              <button type="submit" className="rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-[12px] font-semibold min-h-[44px]">
                Write to Salesforce now
              </button>
            </form>
          )}
        </details>
      )}
      <div className="mt-1 text-[11px] font-mono text-ppp-charcoal-400 break-all">
        {p.payment_intent_id ?? p.checkout_session_id}
      </div>
    </li>
  );
}
