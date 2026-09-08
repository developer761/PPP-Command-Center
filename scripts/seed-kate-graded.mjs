/**
 * Kate's graded conversations, 2026-09-08.
 *
 * The corpus was empty — zero examples — so retrieval had nothing to retrieve
 * and every "the bot sucks" complaint was really "the bot has never been shown
 * a good conversation". These are the first four, and they are unusually
 * valuable because Kate graded them WITH REASONS, which is the whole thing
 * migration 194 exists to capture. A conversation marked bad with nothing
 * attached teaches nothing.
 *
 * Her note precedes each transcript in the message she sent; that ordering is
 * preserved here so the pairing can be checked against the original.
 *
 * PII is scrubbed with the same function the import path uses, and the
 * scrubbed text is what is stored. Run with --apply to write; default is a
 * dry run. Idempotent: re-running matches on the scrubbed transcript.
 */
import { createClient } from "@supabase/supabase-js";
import { scrub, residualPii } from "../lib/messaging/pii.ts";

const APPLY = process.argv.includes("--apply");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const EXAMPLES = [
  {
    date: "2026-08-23",
    conduct: "bad",
    note:
      "Should've introduced phone pricing due to small scope instead of going " +
      "the phone pricing route without notifying the customer. Didn't confirm " +
      "contact information, which is required for phone pricings.",
    tags: ["offsite_suggested", "flow_contact", "ended_too_early"],
    names: [],
    transcript: [
      "Emily: Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! Could you share details about your project and your availability for an appointment? Reply END to stop texts.",
      "Customer: I have a small bedroom that needs to have a wall patched up from a hanging bookshelf and once th wall is patched up just a basic painting of the wall",
      "Emily: You're all set for now—our estimator will reach out soon. If you need anything in the meantime, feel free to get in touch.",
    ].join("\n"),
  },
  {
    date: "2026-08-27",
    conduct: "bad",
    note:
      "Asked for scope instead of using existing scope information from the " +
      "inquiry to confirm needs, never confirmed scope info, asked customer for " +
      "phone number and to type out their phone number. Should've introduced " +
      "phone pricing due to the request for a same-day appointment. Scope from " +
      "inquiry: interior paint, not sure if needs entire apartment or just " +
      "touch-ups, would like in person to assess.",
    tags: ["flow_details", "flow_contact", "offsite_suggested"],
    names: [],
    transcript: [
      "Emily: Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! Could you share details about your project and your availability for an appointment? Reply END to stop texts.",
      "Customer: Hi would someone be able to come by today?",
      "Emily: Yes, we can help with that. Just so I send the right person out, what type of painting or prep work is the estimate for?",
      "Customer: We have a contractor who did very sloppy work already. Not happy w it.",
      "Customer: We would like someone to come assess whether we need to start from scratch to or can just fix it",
      "Emily: Ugh, that's REALLY frustrating, I'm sorry. What's the address for the project, including the zip code?",
      "Customer: Indeed",
      "Customer: 45 e 22nd st 10010",
      "Emily: Got it. For the appointment and quote details, what's the best email address to reach you at?",
      "Customer: Hpolli@gmail.com",
      "Emily: Thanks. And what's the best phone number to reach you at?",
      "Customer: This o ne",
      "Emily: Got it. What's the best 10-digit phone number to use?",
      "Customer: The number we're texting on",
      "Emily: Totally understand. Could you type out the 10-digit number anyway so I make sure we have it exactly right?",
      "Emily: No worries, I can still get this moving. What's the best 10-digit phone number to use for your estimate details?",
    ].join("\n"),
  },
  {
    date: "2026-08-14",
    conduct: "mixed",
    note:
      "The new bot would ideally quote the customer's address back to them to " +
      "confirm, not have them type it out. Otherwise not a bad conversation — " +
      "grabs all required info (scope, address, contact, availability) and hands " +
      "to the human agent without the customer knowing they spoke to AI.",
    tags: ["flow_address", "flow_contact", "flow_availability", "ended_correctly"],
    names: ["Roberto"],
    transcript: [
      "Emily: Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! Could you share details about your project and your availability for an appointment? Reply END to stop texts.",
      "Customer: I want to paint my condo 990 sqft aprox -",
      "Emily: Got it! What's the full address for the condo, including the zip code?",
      "Customer: 41 se 5th st 1814 Miami FL 33131",
      "Emily: Perfect. Is 3059248125 and roberto_0810@hotmail.com the best contact for your appointment and quote details?",
      "Customer: Yes",
      "Emily: Great. We have a few openings next week to meet with you, what would work best for you?",
      "Customer: I'll be home Monday or Tuesday during the day,",
      "Emily: Thank you! Checking our schedule now.",
      "Human agent: Looking at our calendar, we can come by Monday between 4:00PM-5:00PM or 5:00PM-6:00PM, and Tuesday between 10:00AM-5:00PM. What day and time would work best for you?",
      "Customer: Perfect 4-5 pm Monday",
      "Human agent: Thank you! We'll be sending you the confirmed appointment details shortly via email. We're looking forward to meeting you and discussing your project!",
      "Customer: Liked “Thank you! We'll be sending you the confirmed appointment details shortly via email.”",
      "Customer: Do you also paint kitchen cabinets by any chance?",
      "Human agent: Yes, we can! Feel free to ask for a separate quote for that once our estimator comes by.",
    ].join("\n"),
  },
  {
    date: "2026-08-12",
    conduct: "mixed",
    note:
      "Customer had to type the scope out again, since the first message asks " +
      "for project details we already had from the inquiry: \"exterior of my " +
      "house painted, 1500sqft Cape Cod with 1/2 dormer, cedar shake cleaned and " +
      "scraped where necessary and 2 coats of good exterior paint plus windows " +
      "and trim.\" A scope summary merge field would fix this. Other than that, " +
      "gathered all required info. Also negative: the after-hours auto-reply.",
    tags: ["flow_address", "flow_contact", "flow_availability", "flow_details"],
    names: ["Tom"],
    transcript: [
      "Emily: Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! Could you share details about your project and your availability for an appointment? Reply END to stop texts.",
      "Customer: 1500 sf cape cod with 1/2 dormer on 2nd floor attached garage and porch which are all cedar shake. 1st floor of house is unpainted brick. I want cedar shake cleaned and scraped where necessary and 2 coats of good exterior paint plus windows and trim. View house on google maps - 166 S Park Ave, RVC, NY",
      "Emily: Got it! Is 166 S Park Ave, Rockville Centre, NY 11570 the correct address for the estimate?",
      "Customer: Yes",
      "Emily: Great. Is 516-784-6046 and tomrvc@gmail.com the best contact for your appointment and quote details?",
      "Customer: Text me or email please",
      "Emily: Perfect. We have a few openings this week to meet with you, what would work best for you?",
      "Customer: Early afternoon on Friday",
      "Emily: Thank you! Checking our schedule now.",
      "Human agent: We have 1 to 2 pm available on Friday the 14th. I'll get you booked. I'll email you a confirmation shortly.",
      "Customer: That works for me. Thanks",
    ].join("\n"),
  },
];

const rows = EXAMPLES.map((e) => {
  const { text, found } = scrub(e.transcript, e.names);
  return { ...e, scrubbed: text, redacted: found.filter((f) => f.count > 0) };
});

console.log(`Kate's graded conversations — ${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
let blocked = 0;
for (const r of rows) {
  const left = residualPii(r.scrubbed);
  console.log(`${r.date}  ${r.conduct.toUpperCase().padEnd(5)} tags: ${r.tags.join(", ")}`);
  console.log(`   redacted: ${r.redacted.map((f) => `${f.kind}x${f.count}`).join(", ") || "nothing"}`);
  if (left.length) { console.log(`   !! residual PII: ${left.join(", ")} — NOT importing this one`); blocked++; }
}
console.log("");

if (!APPLY) { console.log("Nothing written."); process.exit(0); }

let inserted = 0, skipped = 0;
for (const r of rows) {
  if (residualPii(r.scrubbed).length) continue;

  const { data: existing } = await sb.from("sms_training_examples")
    .select("id").eq("transcript", r.scrubbed).maybeSingle();
  if (existing) { skipped++; continue; }

  const { data, error } = await sb.from("sms_training_examples").insert({
    source: "hatch",
    transcript: r.scrubbed,
    conduct: r.conduct,
    conduct_note: r.note,
    pii_scrubbed: true,
    // Only a good conversation is something to copy. Kate graded these bad and
    // mixed, so they are kept as evidence and never offered as a model.
    approved: false,
    graded_at: new Date().toISOString(),
  }).select("id").single();
  if (error) { console.log(`  insert failed (${r.date}): ${error.message}`); continue; }

  const { error: tagErr } = await sb.from("sms_training_example_tags")
    .insert(r.tags.map((tag_key) => ({ example_id: data.id, tag_key, note: r.note })));
  if (tagErr) console.log(`  tag failed (${r.date}): ${tagErr.message}`);
  inserted++;
}
console.log(`inserted ${inserted}, already present ${skipped}, blocked for PII ${blocked}`);
