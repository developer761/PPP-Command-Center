import Link from "next/link";
import { loadCampaign } from "@/lib/messaging/db";
import { describeAudience, timingOf, campaignWarnings } from "@/lib/messaging/campaign-view";
import CampaignPreview from "@/components/messaging/campaign-preview";
import type { Rule } from "@/lib/messaging/rules";
import type { CampaignStep } from "@/lib/messaging/campaign-schedule";

export const dynamic = "force-dynamic";

/**
 * Campaigns, readable.
 *
 * THE THREE THINGS HATCH MAKES PPP LIVE WITH, and what this does instead.
 *
 * Hatch ties a campaign to ONE workspace, so the same sequence is duplicated
 * across twenty-seven of them and every wording change is twenty-seven edits.
 * Here one campaign covers many workspaces and the page says how many.
 *
 * Hatch keeps the audience as a filter grid. Here it is a sentence, because
 * "who is this going to" is a question with a spoken answer and a grid makes
 * you assemble it yourself every time.
 *
 * Hatch shows you a broken message when a customer receives it. Here the
 * sequence is previewed as the customer will see it, per workspace, with the
 * blanks filled — which is the one thing that would have caught the opener
 * going out reading "Call us at {{workspace_phone}}".
 *
 * What a campaign STILL cannot do is configure its way past the gate. Quiet
 * hours, the opt-out list and the daily cap are not fields here and never will
 * be, and the page says so — the absence of a control is only reassuring if
 * somebody tells you it is deliberate.
 */
export default async function Automations({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const sp = await searchParams;
  const data = await loadCampaign(sp.c);

  if (!data.campaign) {
    return (
      <main className="max-w-3xl mx-auto px-4 py-4 pb-safe">
        <h1 className="font-bold text-ppp-charcoal">Campaigns</h1>
        <div className="mt-3 rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-8 text-center">
          <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
            No campaigns yet. Migration 199 seeds PPP&apos;s Leads Master
            sequence from Kate&apos;s exports.
          </p>
        </div>
      </main>
    );
  }

  const { campaign, campaigns, version, steps, workspaces, workflows, ruleSets, rules } = data;

  const rulesOf = (kind: "entry" | "exit"): Rule[] => {
    const setId = ruleSets.find((s) => s.kind === kind)?.id;
    return rules.filter((r) => r.rule_set_id === setId)
      .map((r) => ({ field: r.field, operator: r.operator as Rule["operator"], values: (r.values ?? []) as unknown[] }));
  };

  const asSteps: CampaignStep[] = steps.map((s) => ({
    ordinal: s.ordinal,
    scheduleMode: s.schedule_mode as CampaignStep["scheduleMode"],
    delayMinutes: s.delay_minutes, dayOffset: s.day_offset, timeOfDay: s.time_of_day,
    channel: s.channel as "sms" | "email", body: s.body, subject: s.subject,
  }));

  const live = workspaces.filter((w) => w.is_active);
  const window = live[0]
    ? { startHour: live[0].quiet_hours_start, endHour: live[0].quiet_hours_end }
    : undefined;
  const warnings = campaignWarnings(asSteps, { workspaceCount: live.length, sendWindow: window });
  const blocking = warnings.filter((w) => w.severity === "blocking");
  const activeWorkflows = workflows.filter((w) => w.is_active).length;
  const published = !!version?.published_at;

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <header>
        <h1 className="font-bold text-ppp-charcoal">{campaign.name}</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          One sequence, {live.length} workspace{live.length === 1 ? "" : "s"}.
          {" "}In Hatch this is {live.length} separate campaigns and every wording
          change is {live.length} edits.
        </p>
      </header>

      {campaigns.length > 1 && (
        <nav className="flex gap-1.5 overflow-x-auto pb-1">
          {campaigns.map((c) => (
            <Link key={c.id} href={`/messaging/automations?c=${c.id}`}
              className={[
                "shrink-0 min-h-[36px] px-3 rounded-lg text-[12.5px] font-medium flex items-center whitespace-nowrap touch-manipulation",
                c.id === campaign.id ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600",
              ].join(" ")}>
              {c.name}
            </Link>
          ))}
        </nav>
      )}

      {/* Is it running? The first question anybody has, and the one Hatch
          makes you click through 27 workspaces to answer. */}
      <section className={[
        "rounded-xl border px-4 py-3",
        activeWorkflows > 0 && published
          ? "border-ppp-green-100 bg-ppp-green-50"
          : "border-ppp-charcoal-200 bg-ppp-charcoal-50",
      ].join(" ")}>
        <p className="text-[13px] font-semibold text-ppp-charcoal">
          {activeWorkflows > 0 && published
            ? `Running in ${activeWorkflows} workspace${activeWorkflows === 1 ? "" : "s"}`
            : "Not running"}
        </p>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
          {!published && "The sequence is not published yet. "}
          {activeWorkflows === 0 && `None of the ${workflows.length} workspaces have it switched on. `}
          Nobody is enrolled and nothing is sent until both are done.
        </p>
      </section>

      {warnings.length > 0 && (
        <section className={[
          "rounded-xl border overflow-hidden",
          blocking.length ? "border-ppp-orange-100" : "border-ppp-charcoal-100",
        ].join(" ")}>
          <div className={`px-4 py-2.5 ${blocking.length ? "bg-ppp-orange-50" : "bg-white"} border-b border-ppp-charcoal-100`}>
            <h2 className={`font-semibold text-[14px] ${blocking.length ? "text-ppp-orange-700" : "text-ppp-charcoal"}`}>
              {blocking.length
                ? `${blocking.length} thing${blocking.length === 1 ? "" : "s"} to fix before this can run`
                : "Worth a look"}
            </h2>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100 bg-white">
            {warnings.map((w, i) => (
              <li key={i} className="px-4 py-2.5">
                <p className={`text-[12.5px] leading-relaxed ${w.severity === "blocking" ? "text-ppp-orange-700" : "text-ppp-charcoal-600"}`}>
                  {w.ordinal !== null && <strong>Message {w.ordinal}: </strong>}
                  {w.message}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The audience, as a sentence rather than a filter grid. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Who gets it</h2>
        </div>
        <div className="px-4 py-3 space-y-2.5">
          <p className="text-[13px] text-ppp-charcoal leading-relaxed">{describeAudience(rulesOf("entry"), "entry")}</p>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400">And it stops when</p>
            <p className="mt-0.5 text-[13px] text-ppp-charcoal leading-relaxed">{describeAudience(rulesOf("exit"), "exit")}</p>
          </div>
        </div>
      </section>

      <CampaignPreview
        steps={asSteps.map((s) => ({
          ordinal: s.ordinal, channel: s.channel, body: s.body,
          subject: s.subject, timing: timingOf(s),
        }))}
        workspaces={live.map((w) => ({ id: w.id, name: w.name, phone_e164: w.phone_e164 }))}
      />

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Where it runs</h2>
        </div>
        <ul className="divide-y divide-ppp-charcoal-100">
          {workflows.map((w) => {
            const ws = workspaces.find((x) => x.id === w.workspace_id);
            return (
              <li key={w.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                <span className="text-[13px] text-ppp-charcoal truncate">{ws?.name ?? w.name}</span>
                <span className={[
                  "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                  w.is_active ? "bg-ppp-green-50 text-ppp-green-700" : "bg-ppp-charcoal-100 text-ppp-charcoal-500",
                ].join(" ")}>
                  {w.is_active ? "on" : "off"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">Not on this page, on purpose</h2>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Quiet hours, the opt-out list and the per-customer daily cap are not
          fields here. A campaign must not be able to configure its way into a
          message somebody told us not to receive, so the send gate holds those
          and no screen can raise them.{" "}
          <Link href="/messaging/settings" className="underline">Hours are per workspace in settings</Link>.
        </p>
      </section>
    </main>
  );
}
