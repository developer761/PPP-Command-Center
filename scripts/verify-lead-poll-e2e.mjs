/**
 * The Salesforce lead poll, against the real database.
 *
 * Salesforce itself is stood in for: the poll takes its query as a function,
 * so this feeds it leads of its own making and never reads or writes anything
 * in Salesforce. What is real is everything after that — the intake table, the
 * routing rules, the entry rules, the workspaces and the throttle.
 *
 * The Angi lead is the point of one of these: Kate's rule excluded "Angi",
 * and Salesforce calls them "Angi Quote Request", so before 2026-09-15 every
 * Angi quote request would have entered the general campaign on top of Angi's
 * own once a workflow was switched on.
 *
 * Cleanup in finally: every row it makes is deleted, and the poll watermark is
 * put back where it was.
 */
import { createClient } from "@supabase/supabase-js";
import { pollSalesforceLeads } from "../lib/messaging/lead-poll.ts";
import { leadFromSalesforce } from "../lib/messaging/lead-map.ts";
import { decideIntake } from "../lib/messaging/lead-intake.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

const stamp = Date.now();
const ids = [`E2E-POLL-A-${stamp}`, `E2E-POLL-B-${stamp}`, `E2E-POLL-C-${stamp}`];
let watermark = null;

const lead = (id, over = {}) => ({
  Id: id, Name: "E2E Lead", FirstName: "E2E",
  MobilePhone: "(999) 222-0170", Email: "e2e@example.invalid",
  LeadSource: "Meta", State: "NY", City: "Garden City",
  RecordType: { Name: "Web Inquiry" }, CreatedDate: new Date().toISOString(),
  Status: "Open", IsConverted: false, SMS_Opt_In__c: null, LeadGroup__c: null, ...over,
});

try {
  console.log(`\nLEAD POLL — real schema, Salesforce stood in for\n`);

  const { data: before } = await sb.from("sf_poll_state").select("last_polled_at").eq("id", true).single();
  watermark = before.last_polled_at;
  const { count: pendingBefore } = await sb.from("sf_lead_inbound")
    .select("*", { count: "exact", head: true }).eq("status", "pending");
  if ((pendingBefore ?? 0) > 0) throw new Error(`${pendingBefore} real lead(s) are pending; this must not process them`);

  /* ── The throttle ───────────────────────────────────────────── */
  await sb.from("sf_poll_state").update({ last_polled_at: new Date().toISOString() }).eq("id", true);
  const throttled = await pollSalesforceLeads(sb, async () => ({ records: [lead(ids[0])] }));
  ok("it does not query Salesforce twice in a minute", throttled.polled === false && /less than a minute/.test(throttled.why ?? ""));

  /* ── A poll that finds three leads ──────────────────────────── */
  await sb.from("sf_poll_state").update({ last_polled_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("id", true);
  let asked = "";
  const res = await pollSalesforceLeads(sb, async (soql) => {
    asked = soql;
    return { records: [
      lead(ids[0]),                                            // a Meta lead with a phone
      lead(ids[1], { LeadSource: "Angi Quote Request" }),      // Angi: excluded by the entry rule
      lead(ids[2], { MobilePhone: null, Phone: null }),        // nothing to text
    ] };
  });

  ok("it asks Salesforce only for new leads, by CreatedDate", /FROM Lead WHERE CreatedDate >/.test(asked));
  ok("it asks for the fields intake reads", /MobilePhone/.test(asked) && /RecordType\.Name/.test(asked));
  ok("all three are recorded", res.found === 3 && res.inserted === 3, JSON.stringify({ found: res.found, inserted: res.inserted }));

  const { data: rows } = await sb.from("sf_lead_inbound")
    .select("sf_record_id, status, triage_reason, workspace_id, phone_e164").in("sf_record_id", ids);
  const byId = Object.fromEntries(rows.map((r) => [r.sf_record_id, r]));

  ok("the lead with no phone goes to triage, saying so",
     byId[ids[2]].status === "triage" && /no_contactable_phone/.test(byId[ids[2]].triage_reason ?? ""),
     `${byId[ids[2]].status}: ${byId[ids[2]].triage_reason}`);

  ok("a routable lead reaches a workspace and is recorded with its number",
     !!byId[ids[0]].workspace_id && byId[ids[0]].phone_e164 === "+19992220170",
     `${byId[ids[0]].status}: ${byId[ids[0]].triage_reason ?? ""}`);

  // No workflow is switched on anywhere yet, so nothing enrols — and that is
  // recorded as a reason rather than looking like a lead that vanished.
  ok("with every workflow off, it says why it did not enter a campaign",
     byId[ids[0]].status === "ignored" && /no active workflow/.test(byId[ids[0]].triage_reason ?? ""),
     byId[ids[0]].triage_reason ?? "");

  /* ── Angi, against the real entry rules ─────────────────────── */
  const { data: rs } = await sb.from("sms_rule_sets").select("id").eq("name", "New lead — web and phone inquiries").single();
  const { data: rules } = await sb.from("sms_rules").select("field, operator, values").eq("rule_set_id", rs.id).order("ordinal");
  const source = rules.find((r) => r.field === "LeadSource");
  ok("the entry rule excludes Salesforce's Angi names, not just \"Angi\"",
     ["Angi Quote Request", "Angi Ads", "Angie's List Quote Request"].every((v) => source.values.includes(v)),
     JSON.stringify(source.values));

  const { matchesAll } = await import("../lib/messaging/rules.ts");
  const angi = leadFromSalesforce(lead(ids[1], { LeadSource: "Angi Quote Request" })).record;
  const meta = leadFromSalesforce(lead(ids[0])).record;
  const asRules = rules.map((r) => ({ field: r.field, operator: r.operator, values: r.values }));
  ok("so an Angi quote request does not match the general campaign", matchesAll(asRules, angi, new Date()) === false);
  ok("and an ordinary Meta lead still does", matchesAll(asRules, meta, new Date()) === true);

  /* ── Arriving twice is a no-op, which is what lets the webhook land ── */
  await sb.from("sf_poll_state").update({ last_polled_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("id", true);
  const again = await pollSalesforceLeads(sb, async () => ({ records: [lead(ids[0])] }));
  const { count: copies } = await sb.from("sf_lead_inbound")
    .select("*", { count: "exact", head: true }).eq("sf_record_id", ids[0]);
  ok("the same lead arriving again is not recorded twice", copies === 1 && again.inserted === 0);

  /* ── Routing, on the real workspaces ────────────────────────── */
  const { data: workspaces } = await sb.from("sms_sub_accounts").select("id, name, is_active, phone_e164");
  const nassau = decideIntake(leadFromSalesforce(lead("x", { City: "Garden City", State: "NY", LeadSource: "Google" })).lead, { workspaces });
  ok("a Garden City lead routes to the Nassau workspace",
     nassau.action === "route" && /Nassau/.test(nassau.workspaceName ?? ""), JSON.stringify(nassau).slice(0, 120));
  const metaLead = decideIntake(leadFromSalesforce(lead("y", { City: "Garden City", State: "NY", LeadSource: "Meta" })).lead, { workspaces });
  ok("a Meta lead routes to a Meta workspace instead, because source wins",
     metaLead.action === "route" && /Meta/.test(metaLead.workspaceName ?? ""), JSON.stringify(metaLead).slice(0, 120));

} catch (err) {
  fail++;
  console.log(`  ✗  stopped early: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await sb.from("sf_lead_inbound").delete().in("sf_record_id", ids);
  if (watermark) await sb.from("sf_poll_state").update({ last_polled_at: watermark }).eq("id", true);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
