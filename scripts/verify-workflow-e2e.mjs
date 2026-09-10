/**
 * PPP's real campaign, run against the engine.
 *
 * Migration 199 seeded Kate's actual audience, her actual remove rules and the
 * actual opener from her exports. Unit tests prove the engine works on
 * invented rules; this proves it works on HERS, which is the only version that
 * ships.
 *
 * Read-only apart from one temporary publish, undone in a finally block.
 */
import { createClient } from "@supabase/supabase-js";
import { matchesAll, matchesAny, firstFailing, describeRule } from "../lib/messaging/rules.ts";
import { scheduleSteps } from "../lib/messaging/campaign-schedule.ts";
import { fillMergeFields, hasUnresolved } from "../lib/messaging/merge-fields.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

const NOW = new Date();
let published = null;

async function rulesOf(name) {
  const { data: set } = await sb.from("sms_rule_sets").select("id").eq("name", name).single();
  const { data } = await sb.from("sms_rules")
    .select("field, operator, values").eq("rule_set_id", set.id).order("ordinal");
  return (data ?? []).map((r) => ({ field: r.field, operator: r.operator, values: r.values ?? [] }));
}

try {
  console.log("\nWORKFLOW ENGINE — Kate's real rules and steps\n");

  const entry = await rulesOf("New lead — web and phone inquiries");
  const exit = await rulesOf("Stop chasing — booked, qualified or opted out");
  ok("her audience loaded", entry.length === 3, `${entry.length} rules`);
  ok("her remove rules loaded", exit.length === 5, `${exit.length} rules`);

  // A lead exactly like the ones in her exports.
  const good = {
    RecordType: "Web Inquiry", LeadSource: "Google",
    CreatedDate: NOW.toISOString(), Status: "Open", IsConverted: false,
  };
  ok("an ordinary web inquiry enters the campaign", matchesAll(entry, good, NOW));
  ok("…and is not immediately removed again", matchesAny(exit, good, NOW) === false);

  // The marketplaces have their own campaigns.
  const thumbtack = { ...good, LeadSource: "Thumbtack" };
  ok("a Thumbtack lead is kept out", matchesAll(entry, thumbtack, NOW) === false,
     describeRule(firstFailing(entry, thumbtack, NOW)));

  // The point of not_in: a source Salesforce never filled in.
  ok("a lead with no source recorded still enters", matchesAll(entry, { ...good, LeadSource: null }, NOW));

  // Yesterday's leads are somebody else's problem.
  const old = { ...good, CreatedDate: new Date(NOW.getTime() - 36 * 3600_000).toISOString() };
  ok("a lead from yesterday is not picked up", matchesAll(entry, old, NOW) === false);

  // Kate's remove rules, one at a time.
  ok("a booked appointment stops the chase",
     matchesAny(exit, { ...good, Opportunity: { AppointmentDate__c: "2026-09-20" } }, NOW));
  ok("a converted lead stops the chase", matchesAny(exit, { ...good, IsConverted: true }, NOW));
  ok("an opted-out lead stops the chase", matchesAny(exit, { ...good, SMS_Opt_In__c: "Opt-Out" }, NOW));
  ok("a qualified lead stops the chase", matchesAny(exit, { ...good, Status: "Qualified" }, NOW));

  // The real sequence.
  const { data: ver } = await sb.from("sms_campaign_versions")
    .select("id, published_at, sms_campaigns(name)").order("version", { ascending: false }).limit(1).single();
  const { data: rawSteps } = await sb.from("sms_campaign_steps")
    .select("ordinal, schedule_mode, delay_minutes, day_offset, time_of_day, channel, body, subject")
    .eq("version_id", ver.id).order("ordinal");

  const steps = rawSteps.map((s) => ({
    ordinal: s.ordinal, scheduleMode: s.schedule_mode, delayMinutes: s.delay_minutes,
    dayOffset: s.day_offset, timeOfDay: s.time_of_day, channel: s.channel,
    body: s.body, subject: s.subject,
  }));
  ok("the sequence has four steps", steps.length === 4);
  ok("…and the second one is an email", steps[1].channel === "email");
  ok("…which carries a subject, as the schema requires", !!steps[1].subject);

  const planned = scheduleSteps(steps, NOW, "America/New_York");
  ok("the opener goes immediately", planned[0].runAt.getTime() === NOW.getTime());
  ok("every later step is after the one before it",
     planned.every((p, i) => i === 0 || p.runAt >= planned[i - 1].runAt));
  const daysOut = (planned[3].runAt.getTime() - NOW.getTime()) / 86_400_000;
  ok("the last chase is about three days out", daysOut > 2.5 && daysOut < 4.5, daysOut.toFixed(1) + "d");

  // The opener, filled for a real workspace.
  const { data: nassau } = await sb.from("sms_sub_accounts")
    .select("name, phone_e164").eq("name", "NY LI Nassau Leads").single();
  const opener = steps[0].body;
  ok("the opener as stored still has a blank in it", hasUnresolved(opener));
  const filled = fillMergeFields(opener, { workspacePhone: nassau.phone_e164, workspaceName: nassau.name });
  ok("…which fills with that workspace's own number", !hasUnresolved(filled) && filled.includes("516-344-8418"));
  ok("…and it already tells them how to stop", /reply\s+end/i.test(filled));

  // Nothing is switched on.
  const { data: wfs } = await sb.from("sms_workflows").select("is_active");
  const { data: camps } = await sb.from("sms_campaigns").select("is_active");
  ok("no workflow is live", wfs.every((w) => !w.is_active), `${wfs.length} seeded`);
  ok("the campaign is not live", camps.every((c) => !c.is_active));
  ok("and the version is unpublished, so nothing can enrol yet", ver.published_at === null);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
} finally {
  if (published) {
    await sb.from("sms_campaign_versions").update({ published_at: null }).eq("id", published);
  }
  const { data: left } = await sb.from("sms_campaign_versions").select("published_at");
  console.log(`cleanup: ${(left ?? []).filter((v) => v.published_at).length} versions published (expect 0)`);
}
process.exit(fail === 0 ? 0 : 1);
