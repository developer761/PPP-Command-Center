/**
 * Demo conversations, so the inbox can be judged as an interface.
 *
 *   node scripts/seed-messaging-demo.mjs          seed
 *   node scripts/seed-messaging-demo.mjs --purge  remove every trace
 *
 * NOT a migration, deliberately. Migrations run on the way to production;
 * this is something a person chooses to run while looking at a screen.
 *
 * Every demo number is in the reserved 555-01XX fictional range — the same
 * block lib/messaging/phone.ts REFUSES as "a test fixture leaked into real
 * input". So a demo row can never collide with a customer, is identifiable by
 * pattern alone, and could not be texted even if sending were switched on.
 * PPP has been bitten before by fabricated data that was indistinguishable
 * from the real thing; this cannot be.
 *
 * The message copy is PPP's own, lifted from the SF Leads Campaign so the row
 * heights and truncation get exercised at real lengths rather than at
 * lorem-ipsum lengths.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const DEMO_PREFIX = "+1555015";           // 555-015X — reserved, unroutable
const isDemo = (p) => p.startsWith(DEMO_PREFIX);
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

if (process.argv.includes("--purge")) {
  const { data } = await sb.from("sms_conversations").select("id, customer_phone");
  const ids = (data ?? []).filter((c) => isDemo(c.customer_phone)).map((c) => c.id);
  if (!ids.length) { console.log("nothing to purge"); process.exit(0); }
  await sb.from("sms_conversations").delete().in("id", ids); // messages cascade
  console.log(`purged ${ids.length} demo conversations`);
  process.exit(0);
}

const { data: ws } = await sb.from("sms_sub_accounts").select("id, name").eq("is_active", true);
const find = (n) => ws.find((w) => w.name === n)?.id ?? ws[0].id;

const OPENER = "Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! Could you share details about your project and your availability for an appointment? If you prefer not to receive texts, call us at (516) 344-8418. Reply END to stop texts.";

const CONVERSATIONS = [
  { name: "Marisol Vega", phone: "+15550150", ws: "NY LI Nassau Leads", state: "human_active", agent: "lead_nurture", mins: 9,
    msgs: [[ "out", OPENER, 240 ], [ "in", "Hi, looking to get the exterior of my house painted. Two storey, colonial.", 232 ],
           [ "out", "Got it. What's the full address including zip?", 230 ],
           [ "in", "42 Hillcrest Ave, Garden City 11530. Also can you do the deck railings while you're here?", 12 ],
           [ "in", "And what's the ballpark on something like that?", 9 ]] },
  { name: "Devon Achebe", phone: "+15550151", ws: "NY NYC Leads", state: "human_active", agent: "lead_nurture", mins: 41,
    msgs: [[ "out", OPENER, 300 ], [ "in", "is this a real person or a bot", 41 ]] },
  { name: null, phone: "+15550152", ws: "NJ Meta", state: "ai_active", agent: "lead_nurture", mins: 3,
    msgs: [[ "out", OPENER, 15 ], [ "in", "Kitchen cabinets, maybe 20 doors", 5 ],
           [ "out", "Okay! What's the full address and zip?", 3 ]] },
  { name: "Priya Raghunathan", phone: "+15550153", ws: "NY LI Suffolk Leads", state: "ai_active", agent: "lead_nurture", mins: 55,
    msgs: [[ "out", OPENER, 1500 ], [ "in", "Interested. Living room and hallway.", 1450 ],
           [ "out", "Got it. Could you confirm your full address and zip?", 1448 ],
           [ "in", "118 Bayview Rd, Sayville 11782", 70 ],
           [ "out", "Thank you! We have a few openings this week to meet with you, what would work best for you?", 55 ]] },
  { name: "Tomasz Wiśniewski", phone: "+15550154", ws: "FL Broward Leads", state: "awaiting_customer", agent: "followup", mins: 1580,
    msgs: [[ "out", OPENER, 4300 ], [ "in", "Need the whole interior done before we move in on the 30th", 4200 ],
           [ "out", "Okay! What's the full address and zip?", 4198 ],
           [ "out", "Good morning! Just checking in to see if you're still interested in a free estimate. Do you have a few minutes today to chat?", 1580 ]] },
  { name: "Rae Lindqvist", phone: "+15550155", ws: "NY Queens Leads", state: "awaiting_customer", agent: "lead_nurture", mins: 2900,
    msgs: [[ "out", OPENER, 5800 ], [ "in", "how much for one accent wall", 5700 ],
           [ "out", "We can provide a quick quote for this project. Do you prefer text or email?", 2900 ]] },
  { name: "Ana Beatriz Correia", phone: "+15550156", ws: "SoFlo Meta", state: "ended", outcome: "success", agent: "lead_nurture", mins: 190,
    msgs: [[ "out", OPENER, 800 ], [ "in", "Yes! Exterior, single storey, and the fence.", 780 ],
           [ "out", "Okay! What's the full address and zip?", 778 ], [ "in", "9 Palmetto Ct, Plantation 33324", 700 ],
           [ "out", "Thank you! We have a few openings this week to meet with you, what would work best for you?", 698 ],
           [ "in", "Thursday afternoon works", 200 ], [ "out", "Appreciate it, checking our schedule.", 190 ]] },
  { name: "Grant Ozanne", phone: "+15550157", ws: "NY Wstch Leads", state: "ended", outcome: "area_not_serviced", agent: "lead_nurture", mins: 620,
    msgs: [[ "out", OPENER, 700 ], [ "in", "6 Old Post Rd, Kent CT 06757", 640 ], [ "out", "Just a moment", 620 ]] },
  { name: "Hollis Mbeki", phone: "+15550158", ws: "NY LI Meta", state: "ended", outcome: "lost", agent: "lead_nurture", mins: 4300,
    msgs: [[ "out", OPENER, 6000 ], [ "in", "went with someone else, thanks", 4310 ],
           [ "out", "Understood! We'll be here if things change.", 4300 ]] },
  { name: "Siobhán Kelleher", phone: "+15550159", ws: "AM - NY", state: "ended", outcome: "phone_pricing", agent: "lead_nurture", mins: 2100,
    msgs: [[ "out", OPENER, 2600 ], [ "in", "just need a rough number for a small bathroom", 2400 ],
           [ "out", "We can provide a quick quote for this project. Do you prefer text or email?", 2390 ],
           [ "in", "email is fine", 2110 ],
           [ "out", "You're all set for now and will hear from the estimator soon. Keep in touch if you need anything in the meantime.", 2100 ]] },
];

let convN = 0, msgN = 0;
for (const c of CONVERSATIONS) {
  const { data: conv, error } = await sb.from("sms_conversations").insert({
    workspace_id: find(c.ws), customer_phone: c.phone, customer_name: c.name,
    state: c.state, outcome: c.outcome ?? null,
    ended_at: c.state === "ended" ? ago(c.mins) : null,
    owning_agent: c.state === "ended" ? null : c.agent,
    consent_basis: "inquiry", last_message_at: ago(c.mins),
  }).select().single();
  if (error) { console.log(`  ✗ ${c.phone}: ${error.message}`); continue; }
  convN++;
  for (const [dir, body, mins] of c.msgs) {
    const { error: me } = await sb.from("sms_messages").insert({
      conversation_id: conv.id, direction: dir === "out" ? "outbound" : "inbound",
      channel: "sms", body,
      sent_by_agent: dir === "out" ? c.agent : null,
      delivery_status: dir === "out" ? "delivered" : null,
      created_at: ago(mins),
    });
    if (!me) msgN++;
  }
}
console.log(`seeded ${convN} demo conversations, ${msgN} messages`);
console.log("every number is in the reserved 555-01XX range — unroutable, and refused by toE164()");
console.log("undo: node scripts/seed-messaging-demo.mjs --purge");
