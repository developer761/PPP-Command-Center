import Link from "next/link";
import { redirect } from "next/navigation";
import { PayShell } from "@/components/pay/pay-shell";
import { demoEnabled } from "@/lib/payments/demo";
import { SIM_NOTE } from "@/lib/payments/demo-sim";
import { startDemo } from "@/lib/payments/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Online payments demo · Precision Painting Plus", robots: { index: false } };

/**
 * /demo/payments — the link to send someone to SEE online invoice payments
 * work, end to end, on the real site. "Start the demo" makes a fresh made-up
 * job (nothing paid) and opens its pay page. Test cards only; nothing reaches
 * Salesforce. See lib/payments/demo.ts for why it can't touch real money.
 */

async function startDemoAction() {
  "use server";
  const r = await startDemo();
  if (!r.ok) redirect(`/demo/payments?busy=${r.reason}`);
  redirect(`/pay/${r.token}`);
}

const STEPS: { title: string; body: string }[] = [
  {
    title: "The customer opens the link on their invoice",
    body: "They see the job split into Deposit, Progress and Final with exact amounts. Only what’s due can be paid, so nobody types their own number.",
  },
  {
    title: "They pay the Deposit by card",
    body: "Under Deposit, tap “Pay by card”. The test card is already filled in — pick credit or debit. A credit card adds the 3% fee; a debit card has none. The final total shows before paying.",
  },
  {
    title: "Back on the invoice, the Deposit is taken care of",
    body: "It shows as paid and the Progress payment is next. Try paying Progress by bank (ACH): no fee, and it shows as Processing while it clears.",
  },
  {
    title: "The office sees it in the Command Center",
    body: "The payment lands on the Payments tab under its job, with the card fee kept separate, plus an Excel export and a daily email. The demo’s thank-you page shows what the office gets.",
  },
  {
    title: "In real life, Salesforce is updated by itself",
    body: "When Stripe deposits the money, the Command Center adds the Payment In on the Work Order (without the fee) and marks the Payment Term paid. The demo stops before this step — it isn’t a real Work Order.",
  },
];

export default async function PaymentsDemoPage({ searchParams }: { searchParams: Promise<{ busy?: string }> }) {
  const { busy } = await searchParams;
  const live = demoEnabled();

  return (
    <PayShell previewNote={live ? "DEMO · Stripe test mode. No real money moves, and nothing goes to Salesforce." : SIM_NOTE}>
      <div className="space-y-5">
        <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6">
          <div className="text-[11px] font-condensed uppercase tracking-[0.16em] text-ppp-charcoal-500">Demo</div>
          <h1 className="mt-1 text-xl sm:text-2xl font-bold text-ppp-navy">Online invoice payments</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ppp-charcoal-700">
            Walk through exactly what a customer does, on a made-up $5,000 job. The card is filled in for you — nothing to
            type. Every time you press Start you get a fresh job with nothing paid.
          </p>
          <p className="mt-2 text-[12px] text-ppp-charcoal-500">
            {live
              ? "Runs through Stripe in test mode — no real money moves."
              : "Simulated — no card is charged and nothing is saved."}
          </p>

          {busy === "busy" && (
            <p role="alert" className="mt-4 rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 text-[13px] text-ppp-orange-700">
              Lots of demos started in the last hour — please try again in a few minutes.
            </p>
          )}

          {live ? (
            <form action={startDemoAction} className="mt-5">
              <button
                type="submit"
                className="w-full rounded-xl bg-ppp-navy text-white px-4 min-h-[52px] text-base font-semibold hover:bg-ppp-navy-900"
              >
                Start the demo
              </button>
            </form>
          ) : (
            <Link
              href="/demo/payments/invoice"
              className="mt-5 flex w-full items-center justify-center rounded-xl bg-ppp-navy text-white px-4 min-h-[52px] text-base font-semibold hover:bg-ppp-navy-900"
            >
              Start the demo
            </Link>
          )}
        </section>

        <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6">
          <h2 className="text-base font-semibold text-ppp-navy">What you&rsquo;ll see</h2>
          <ol className="mt-3 space-y-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ppp-navy text-[12px] font-bold text-white">
                  {i + 1}
                </span>
                <div>
                  <div className="text-[14px] font-semibold text-ppp-charcoal">{s.title}</div>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ppp-charcoal-600">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </PayShell>
  );
}
