import Link from "next/link";
import { messagingDb } from "@/lib/messaging/db";
import { assertMessagingAccess } from "@/lib/messaging/auth";

export const dynamic = "force-dynamic";

/**
 * WHAT THE HUB OWES THE CALL CENTRE, AND WHETHER IT HAS GONE.
 *
 * Three signals cross between the Hub and the phone team, and until this
 * screen existed all three were written to a table nobody could read. The
 * spec's own bullet — "the Hub records the ending as Stalled conversation" —
 * was satisfied in the database and nowhere a person could see it, which is
 * the same as not satisfied.
 *
 * ── THIS IS ALSO THE DELIVERY SEAM, FOR NOW ─────────────────────────────
 *
 * The spec leaves delivery deliberately unspecified: "Build the two signals
 * with the destination left as a seam." A screen somebody reads IS a
 * destination — the worst one, but a real one, and better than a queue that
 * grows silently while everybody assumes it is wired. When a webhook or an
 * inbox replaces it, `delivered_at` starts being stamped and this becomes the
 * audit of it rather than the mechanism.
 *
 * ── WHY IT DOES NOT READ AS A VERDICT ───────────────────────────────────
 *
 * "A notification that reads as 'this lead is done' is the failure to avoid."
 * So the screen shows what the customer did and what somebody has to do about
 * it, and never a disposition. The note comes from call-signals.ts, which is
 * guarded by readsAsADisposition.
 */
const LABEL: Record<string, { title: string; why: string }> = {
  pause_calling: {
    title: "Stop dialling",
    why: "They replied to us, so the phone team should leave them alone while the conversation is live. Temporary — it lifts on its own.",
  },
  resume_calling: {
    title: "Start dialling again",
    why: "Three follow-ups went unanswered. Nothing about the lead has changed; we have simply spent our side of it.",
  },
  remove_from_cadence: {
    title: "Take off the call cadence",
    why: "They asked to be contacted by text or email rather than by phone. Permanent, and it needs doing in Salesforce by hand.",
  },
};

export default async function SignalsPage() {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data } = await sb
    .from("sms_call_signals")
    .select("id, conversation_id, kind, sf_lead_id, note, created_at, delivered_at, delivery_error")
    // Undelivered first — this is a queue before it is a history.
    .order("delivered_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as {
    id: string; conversation_id: string; kind: string; sf_lead_id: string | null;
    note: string; created_at: string; delivered_at: string | null; delivery_error: string | null;
  }[];
  const waiting = rows.filter((r) => !r.delivered_at);

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <header>
        <h1 className="text-[17px] font-semibold text-ppp-charcoal">Call centre signals</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
          The only things that pass between the Hub and the phone team. Nothing here changes a
          call cadence or writes to Salesforce — each one is a note asking a person to.
        </p>
      </header>

      {waiting.length > 0 && (
        <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700 leading-relaxed">
          {waiting.length} {waiting.length === 1 ? "signal has" : "signals have"} not been
          passed on yet. Until delivery is wired up, this screen is how they reach anybody.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Nothing yet. These appear when a customer replies, when a follow-up cadence is spent,
          or when somebody asks to come off the phone.
        </p>
      ) : (
        <ul className="rounded-xl border border-ppp-charcoal-100 bg-white divide-y divide-ppp-charcoal-100 overflow-hidden">
          {rows.map((r) => {
            const l = LABEL[r.kind] ?? { title: r.kind, why: "" };
            return (
              <li key={r.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-ppp-charcoal">{l.title}</p>
                    <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">{l.why}</p>
                  </div>
                  <span className={["shrink-0 text-[10.5px] font-mono uppercase tracking-wide",
                    r.delivered_at ? "text-ppp-charcoal-400" : "text-ppp-orange-700"].join(" ")}>
                    {r.delivered_at ? "passed on" : "waiting"}
                  </span>
                </div>

                <p className="mt-1.5 text-[12px] text-ppp-charcoal-600 leading-relaxed">{r.note}</p>

                <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono text-ppp-charcoal-400">
                  <Link href={`/messaging/${r.conversation_id}`} className="underline underline-offset-2">
                    the conversation
                  </Link>
                  {r.sf_lead_id && <span>lead {r.sf_lead_id}</span>}
                  <span>{new Date(r.created_at).toLocaleString()}</span>
                  {r.delivery_error && <span className="text-ppp-orange-700">{r.delivery_error}</span>}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
