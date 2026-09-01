import { messagingDb } from "@/lib/messaging/db";

export const dynamic = "force-dynamic";

const MODE_LABEL: Record<string, string> = {
  at_launch: "on entry",
  delay_after_last: "after the last message",
  absolute_on_day: "at a set time",
};

/**
 * Automations — campaigns as editable data.
 *
 * PPP edits these in Hatch today. Losing that is the regression that would stop
 * them agreeing to cancel, so parity here means parity of CONTROL, not just of
 * the messages that go out.
 *
 * What a campaign cannot do is configure its way past the gate: quiet hours,
 * the opt-out check and the daily cap are not fields on this screen and never
 * will be. Said plainly on the page, because the absence of a control is only
 * reassuring if somebody tells you it is deliberate.
 */
export default async function Automations() {
  const sb = messagingDb();
  const { data: campaigns } = await sb
    .from("sms_campaigns")
    .select("id, name, trigger_event, is_active, send_on_weekends, send_on_holidays, sms_sub_accounts(name)")
    .order("name");

  const ids = (campaigns ?? []).map((c) => c.id);
  const { data: versions } = ids.length
    ? await sb.from("sms_campaign_versions").select("id, campaign_id, version, published_at").in("campaign_id", ids)
    : { data: [] };
  const { data: steps } = versions?.length
    ? await sb.from("sms_campaign_steps").select("version_id, ordinal, schedule_mode, channel, day_offset, time_of_day, delay_minutes, body").in("version_id", versions.map((v) => v.id)).order("ordinal")
    : { data: [] };

  const stepsFor = (campaignId: string) => {
    const vs = (versions ?? []).filter((v) => v.campaign_id === campaignId).sort((a, b) => b.version - a.version)[0];
    return vs ? (steps ?? []).filter((s) => s.version_id === vs.id) : [];
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-4 pb-safe">
      <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <p className="text-[13px] font-semibold text-ppp-charcoal">Campaigns are data, not code</p>
        <p className="mt-1 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          Steps, delays and exit conditions are editable here — changing a
          follow-up delay is an edit, not a deploy. Quiet hours, the opt-out
          check and the per-customer daily cap are deliberately <em>not</em>
          {" "}fields on this screen: a campaign must not be able to configure its
          way into a message somebody told us not to send.
        </p>
      </div>

      {(campaigns ?? []).length === 0 ? (
        <div className="mt-4 rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-10 text-center">
          <p className="font-semibold text-ppp-charcoal">No campaigns yet</p>
          <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-md mx-auto">
            PPP&apos;s live campaigns — the SF Leads Campaign per region and the
            Leads Master Campaign for the Meta workspaces — get imported from
            Hatch, then become editable here.
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {(campaigns ?? []).map((c) => {
            const ws = c.sms_sub_accounts as unknown as { name: string } | null;
            const cSteps = stepsFor(c.id);
            return (
              <li key={c.id} className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
                <div className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ppp-charcoal truncate">{c.name}</p>
                    <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 truncate">
                      {ws?.name ?? "All workspaces"} · triggers on {c.trigger_event.replace(/_/g, " ")}
                    </p>
                  </div>
                  <span className={[
                    "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold",
                    c.is_active ? "bg-ppp-green-50 text-ppp-green-700" : "bg-ppp-charcoal-100 text-ppp-charcoal-500",
                  ].join(" ")}>
                    {c.is_active ? "Active" : "Paused"}
                  </span>
                </div>
                {cSteps.length > 0 && (
                  <ol className="border-t border-ppp-charcoal-100 divide-y divide-ppp-charcoal-50">
                    {cSteps.map((s) => (
                      <li key={`${s.version_id}-${s.ordinal}`} className="px-4 py-2.5 flex gap-3">
                        <span className="shrink-0 mt-0.5 h-5 w-5 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-500 text-[10px] font-bold flex items-center justify-center tabular-nums">
                          {s.ordinal}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[11px] font-mono uppercase tracking-wide text-ppp-charcoal-400">
                            {s.channel} · {MODE_LABEL[s.schedule_mode] ?? s.schedule_mode}
                            {s.day_offset != null ? ` · day ${s.day_offset}` : ""}
                            {s.time_of_day ? ` ${String(s.time_of_day).slice(0, 5)}` : ""}
                            {s.delay_minutes != null ? ` · +${s.delay_minutes}m` : ""}
                          </p>
                          <p className="mt-0.5 text-[13px] text-ppp-charcoal-600 line-clamp-2 leading-relaxed">{s.body}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
