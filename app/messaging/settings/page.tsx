import Link from "next/link";
import { messagingDb } from "@/lib/messaging/db";
import { federalBound } from "@/lib/messaging/workspace-settings";
import WorkspaceHoursForm, { type Row } from "@/components/messaging/workspace-hours-form";

export const dynamic = "force-dynamic";

/**
 * Hours, timezone and after-hours behaviour, per workspace.
 *
 * The opt-out list and the per-customer daily cap are still not here. Those
 * are not preferences — they are the reason a message is allowed to exist, and
 * they live in the send gate with tests behind them. Hours ARE a preference,
 * and PPP's workspaces genuinely differ, so they belong on a screen.
 */
export default async function MessagingSettings({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>;
}) {
  const sp = await searchParams;
  const sb = messagingDb();
  const bound = await federalBound();

  const { data } = await sb
    .from("sms_sub_accounts")
    .select("id, name, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends, after_hours_autoreply, after_hours_message")
    .eq("is_active", true)
    .order("name");
  const rows = (data ?? []) as Row[];
  const open = sp.ws ?? rows[0]?.id;

  const oddTimezones = rows.filter((r) => !r.time_zone);

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <header>
        <h1 className="font-bold text-ppp-charcoal">Settings</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          When each workspace is allowed to text, and in which timezone. Saved
          changes apply to the next message — there is no deploy step.
        </p>
      </header>

      {oddTimezones.length > 0 && (
        <section className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-ppp-orange-700">
            {oddTimezones.length} live workspace{oddTimezones.length === 1 ? " has" : "s have"} no timezone
          </p>
          <p className="mt-1 text-[12.5px] text-ppp-orange-700/90 leading-relaxed">
            Without one there is no such thing as 9am for them, so quiet hours
            cannot be checked and the gate refuses the send rather than guessing.
          </p>
        </section>
      )}

      <nav className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {rows.map((r) => (
          <Link key={r.id} href={`/messaging/settings?ws=${r.id}`}
            className={[
              "shrink-0 min-h-[36px] px-3 rounded-lg text-[12.5px] font-medium flex items-center whitespace-nowrap touch-manipulation",
              open === r.id ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600",
            ].join(" ")}>
            {r.name}
          </Link>
        ))}
      </nav>

      {/* A ws that is not in the live list — stale bookmark, deactivated
          workspace — showed the tab strip and then nothing at all, which reads
          as a page that failed rather than a selection that no longer exists. */}
      {rows.length === 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-7 text-center">
          <p className="text-[13px] text-ppp-charcoal-500">No workspaces are live, so there are no hours to set.</p>
        </section>
      )}
      {rows.length > 0 && !rows.some((r) => r.id === open) && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-7 text-center">
          <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed">
            That workspace is not live any more. Pick one above.
          </p>
        </section>
      )}

      {rows.filter((r) => r.id === open).map((r) => (
        <section key={r.id} className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
            <h2 className="font-semibold text-ppp-charcoal text-[14px]">{r.name}</h2>
            <p className="mt-0.5 text-[12px] text-ppp-charcoal-500">
              {r.time_zone ?? "No timezone set"}
              {r.quiet_hours_start != null && r.quiet_hours_end != null
                ? ` · sends ${r.quiet_hours_start}:00–${r.quiet_hours_end}:00`
                : " · using the default window"}
            </p>
          </div>
          <WorkspaceHoursForm row={r} bound={bound} />
        </section>
      ))}

      <Link href="/messaging/settings/opt-outs"
        className="block rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 touch-manipulation">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">Who we must not text</h2>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Load Hatch&apos;s suppression list. This is checked before every send and
          has to be in before the first real message goes out.
        </p>
      </Link>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">Not on this page, on purpose</h2>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          The opt-out list and the per-customer daily cap are enforced in the
          send gate and have no field anywhere. They are not preferences: they
          are the reason a message is allowed to exist at all, and a screen that
          can raise a cap is a screen that can text somebody eleven times.
          Changing either is a code change with a test behind it.
        </p>
      </section>
    </main>
  );
}
