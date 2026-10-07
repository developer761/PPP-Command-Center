/**
 * IS THE PUBLIC SITE SAYING WHAT WE TOLD TWILIO IT SAYS?
 *
 *   npm run check:consent
 *
 * READ ONLY. Fetches public pages over HTTPS and asserts. Sends nothing,
 * writes nothing, touches no database.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * Three registration rejections, all about the consent wording on a site we
 * do not own and cannot deploy:
 *
 *   30508  the checkbox was pre-selected
 *   30507  the opt-in did not match the use case — the box promised "special
 *          offers and home improvement tips" by SMS while we registered an
 *          informational Customer Care campaign
 *   —      marketing consent was combined with service consent, which
 *          carriers require to be collected separately
 *
 * Each round trip was checked by hand, in the browser, one page at a time.
 * The second check missed that a JavaScript-set `checked` property would not
 * appear as a `checked` ATTRIBUTE in fetched HTML — so "all 228 pages clean"
 * was measured the wrong way and had to be redone against the live DOM.
 *
 * A fourth round trip should cost one command, not an afternoon. This asserts
 * the whole shape at once: the two separate boxes, what each may and may not
 * say, and the two policy pages that have to agree with them.
 *
 * ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────
 *
 * Fetched HTML only. If a script ticks the box at runtime this cannot tell,
 * because there is no DOM here. It checks the `checked` attribute and says so
 * in its output; the live-DOM check stays a browser job.
 */

const SITE = "https://www.precisionpaintingplus.net";
const FORM_PAGE = `${SITE}/estimate/`;
const PRIVACY = `${SITE}/privacy/`;
const TERMS = `${SITE}/terms-conditions/`;

let pass = 0, fail = 0, warn = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? `  ${extra}` : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? `  ${extra}` : ""}`); }
};
const note = (label, extra = "") => { warn++; console.log(`  !  ${label}${extra ? `  ${extra}` : ""}`); };
const head = (t) => console.log(`\n${t}`);

const get = async (url) => {
  const r = await fetch(url, { redirect: "follow", headers: { "cache-control": "no-cache" } });
  return { status: r.status, finalUrl: r.url, html: await r.text() };
};

/** Crude, deliberately. We want the text a reviewer reads, not a parse tree. */
const textOf = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#8217;|&rsquo;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

/**
 * THE SAME ESTIMATE FORM IS EMBEDDED IN EVERY PAGE, AND IT IS NOT THE PAGE.
 *
 * Both policy pages carry a copy of the estimate form in the footer, consent
 * sentences and all. Asserting on the whole page therefore reads the FORM's
 * words as the POLICY's words, and on 2026-10-06 that was wrong in both
 * directions at once:
 *
 *   false PASS  Terms & Conditions "carries a rates disclosure" — it does not.
 *               The page is promotions only; the sentence came from the form
 *               in its footer. The headed-section check below already warns
 *               about exactly this leak, one assertion further down.
 *   false FAIL  Privacy "still quotes a combined marketing+SMS sentence" — it
 *               does not. The policy separates them correctly in its own
 *               words; the embedded form supplied both halves.
 *
 * A check that can fail a correct page is worse than no check, because
 * somebody goes and "fixes" it. So the prose assertions run against the page
 * with the form cut out, and the form assertions keep the full HTML.
 */
const withoutEmbeddedForm = (html) =>
  html.replace(/<form[^>]*class="[^"]*wpcf7-form[^"]*"[\s\S]*?<\/form>/gi, " ");

/**
 * Every wpcf7-acceptance block, with the two attributes that got us rejected
 * and the words that decide which box it is.
 */
function acceptanceBoxes(html) {
  const out = [];
  const re = /<span[^>]*class="[^"]*wpcf7-acceptance[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/gi;
  for (const m of html.matchAll(re)) {
    const block = m[0];
    out.push({
      optional: /\bwpcf7-acceptance\b[^"]*\boptional\b/i.test(block) || /class="[^"]*\boptional\b/i.test(block),
      checkedAttr: /<input[^>]*type="checkbox"[^>]*\bchecked\b/i.test(block),
      text: textOf(block),
    });
  }
  return out;
}

const MARKETING_WORDS = /special offers|promotions?|home improvement tips|deals|newsletter/i;
const SMS_WORDS = /text message|sms/i;

console.log("CONSENT COMPLIANCE — the public site, as a carrier reviewer sees it");
console.log(`  ${SITE}\n  (read only — nothing is submitted)`);

/* ── 1. The estimate form ──────────────────────────────────────────────── */
head("1. The consent boxes on the estimate form");
const form = await get(FORM_PAGE);
ok("the estimate page loads", form.status === 200, String(form.status));

const boxes = acceptanceBoxes(form.html);
ok("the page has consent checkboxes at all", boxes.length > 0, `${boxes.length} found`);

const smsBoxes = boxes.filter((b) => SMS_WORDS.test(b.text));
const marketingOnly = boxes.filter((b) => MARKETING_WORDS.test(b.text) && !SMS_WORDS.test(b.text));

ok("there is a checkbox about text messages", smsBoxes.length > 0, `${smsBoxes.length}`);

/**
 * THE REJECTION ITSELF. A box that asks for SMS consent and markets in the
 * same sentence is the thing carriers refuse.
 */
for (const [i, b] of smsBoxes.entries()) {
  ok(`SMS box ${i + 1} does NOT also collect marketing consent`,
     !MARKETING_WORDS.test(b.text),
     MARKETING_WORDS.test(b.text) ? `still says "${(b.text.match(MARKETING_WORDS) ?? [])[0]}"` : "");
  ok(`SMS box ${i + 1} is not pre-selected (checked attribute)`, !b.checkedAttr);
  ok(`SMS box ${i + 1} carries STOP`, /\bSTOP\b/.test(b.text));
  ok(`SMS box ${i + 1} carries HELP`, /\bHELP\b/.test(b.text));
  ok(`SMS box ${i + 1} carries message frequency`, /frequency varies/i.test(b.text));
  ok(`SMS box ${i + 1} carries rates`, /rates may apply/i.test(b.text));
  ok(`SMS box ${i + 1} names the brand`, /Precision Painting Plus/i.test(b.text));
}

if (marketingOnly.length) {
  ok("marketing consent is its own separate box", true, `${marketingOnly.length}`);
  for (const [i, b] of marketingOnly.entries()) {
    ok(`marketing box ${i + 1} is optional`, b.optional);
    ok(`marketing box ${i + 1} is not pre-selected`, !b.checkedAttr);
  }
} else if (boxes.some((b) => MARKETING_WORDS.test(b.text))) {
  ok("marketing consent is its own separate box", false,
     "marketing words appear only inside an SMS box — this is the current rejection");
} else {
  note("no marketing consent box found at all", "fine if PPP stopped collecting it; confirm it is deliberate");
}

/* ── 2. Privacy policy ─────────────────────────────────────────────────── */
head("2. Privacy Policy");
const privacy = await get(PRIVACY);
const pText = textOf(withoutEmbeddedForm(privacy.html));
ok("loads", privacy.status === 200, String(privacy.status));
ok('titled "Privacy Policy"', /<title[^>]*>[^<]*Privacy Policy/i.test(privacy.html));
ok("names the brand", /Precision Painting Plus/i.test(pText));
ok("carries the exact no-sell statement carriers look for",
   /We do not sell or share your SMS opt-?in data or personal information with third parties for marketing purposes/i.test(pText));
ok("has an SMS section", /SMS TERMS|SMS & EMAIL OPT/i.test(pText));

/**
 * The policy quotes the form's consent sentence. If the form changes and this
 * does not, the two disagree and a reviewer reads both.
 *
 * NEARNESS IS NOT COMBINATION, which this used to assume. It matched the two
 * subjects within 120 characters of each other, and the sentence a carrier
 * most wants to see says both in one breath ON PURPOSE:
 *
 *   "Email marketing (special offers and home improvement tips) is offered as
 *    a separate, optional opt-in and is not required to receive text messages."
 *
 * That is the fix for rejection 30507 written out in plain English, and the
 * check marked it as the rejection. Somebody acting on that would have deleted
 * the sentence that proves compliance.
 *
 * So it reads SENTENCES, and a sentence holding both subjects only fails when
 * it reads as one CONSENT and does not say they are separate.
 */
const SEPARATION = /\bseparate\b|\boptional\b|\bnot required\b|\bdoes not require\b/i;
const CONSENT_VERB = /\bI agree\b|\bI'd also like\b|\bI would also like\b|\byou agree\b|\bby (?:submitting|checking)\b|\bconsent to receive\b/i;
const findCombined = (text) => text
  .split(/(?<=[.?!])\s+/)
  .find((s) => SMS_WORDS.test(s) && MARKETING_WORDS.test(s)
            && CONSENT_VERB.test(s) && !SEPARATION.test(s));

/**
 * The detector is checked against the two sentences it has to tell apart,
 * every run. Narrowing a rule until it stops firing is the easy mistake here,
 * and a rule that can no longer catch the original rejection would pass this
 * page in silence for ever.
 */
{
  const REJECTED = "I agree to receive text messages from Precision Painting Plus with special offers and home improvement tips.";
  const CORRECT = "Email marketing (special offers and home improvement tips) is offered as a separate, optional opt-in and is not required to receive text messages.";
  if (!findCombined(REJECTED) || findCombined(CORRECT)) {
    console.error("\n✗  the combined-consent detector itself is broken — it no longer tells 30507's wording from the fix for it. Nothing below can be trusted.");
    process.exit(1);
  }
}

const combinedSentence = findCombined(pText);
ok("does not still quote a combined marketing+SMS consent sentence", !combinedSentence,
   combinedSentence ? `still reproduced here: "${combinedSentence.slice(0, 160)}"` : "");

/* ── 3. The SMS programme terms ────────────────────────────────────────── */
head("3. The SMS terms, wherever they live");
/**
 * ON WHICHEVER PAGE WE REGISTER, NOT NECESSARILY THE TERMS PAGE.
 *
 * This asserted the terms section on /terms-conditions/ because that is the
 * URL first given to Twilio. Katie's question on 2026-10-06 was the right one:
 * that page is PPP's promotions terms — the $199 room offer, the satisfaction
 * guarantee — and SMS terms read oddly bolted onto it.
 *
 * The requirement is not about a page title. It is that the URL submitted as
 * the campaign's terms link carries the programme terms a reviewer checks for.
 * So the check looks on both candidate pages and NAMES the one to register,
 * rather than dictating where PPP writes it.
 */
const terms = await get(TERMS);
const tText = textOf(withoutEmbeddedForm(terms.html));
ok("the terms page loads", terms.status === 200, String(terms.status));

const SMS_TERMS_HEADING = /SMS\s*TERMS|Text\s*Messaging\s*Terms|SMS\s*Program\s*Terms/i;
/** The section, from its heading to the next one, so the checks below read IT. */
function smsTermsSection(text) {
  const m = SMS_TERMS_HEADING.exec(text);
  if (!m) return null;
  const after = text.slice(m.index);
  // Up to the next ALL-CAPS heading, or 1,200 characters, whichever is first.
  const next = /\.\s+[A-Z][A-Z &'/]{9,}/.exec(after.slice(m[0].length));
  return after.slice(0, next ? m[0].length + next.index + 1 : 1200);
}

const candidates = [
  { label: "Privacy Policy", url: PRIVACY, section: smsTermsSection(pText) },
  { label: "Terms & Conditions", url: TERMS, section: smsTermsSection(tText) },
];
const carrying = candidates.filter((c) => c.section);
ok("a headed SMS Terms section exists somewhere we can point Twilio at",
   carrying.length > 0,
   carrying.length ? `on the ${carrying.map((c) => c.label).join(" and the ")}` : "neither page has one");

if (carrying.length) {
  // Read the FIRST one that has it; that is the URL to submit.
  const s = carrying[0].section;
  console.log(`     → register this URL as the campaign's terms link: ${carrying[0].url}`);
  ok("  the section names the brand", /Precision Painting Plus/i.test(s));
  ok("  the section says what the messages are about",
     /estimate|scheduling|customer service|appointment/i.test(s));
  ok("  the section carries message frequency", /frequency\s+varies|message\s+frequency/i.test(s));
  ok("  the section carries the rates disclosure", /rates\s+may\s+apply/i.test(s));
  ok("  the section carries STOP", /\bSTOP\b/.test(s));
  ok("  the section carries HELP", /\bHELP\b/.test(s));
  // Not required by every carrier, and reviewers look for it.
  if (!/carriers?\s+are\s+not\s+liable|not\s+liable\s+for\s+delayed/i.test(s)) {
    note("  no carrier-liability sentence", "accepted without it, but reviewers look for one");
  }
}

/* ── 4. The URLs we gave Twilio ────────────────────────────────────────── */
head("4. The URLs on the registrations resolve");
for (const [label, url] of [["privacy", PRIVACY], ["terms", TERMS], ["opt-in proof", FORM_PAGE]]) {
  const r = await get(url);
  ok(`${label} returns 200`, r.status === 200, r.finalUrl !== url ? `redirects to ${r.finalUrl}` : "");
}

console.log(`\n${"=".repeat(70)}`);
console.log(`${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass + fail} checks${warn ? `, ${warn} note(s)` : ""}`);
console.log("Fetched HTML only: a box ticked by JavaScript cannot be seen here.");
console.log("Confirm the live DOM in a browser before resubmitting.\n");
process.exit(fail === 0 ? 0 : 1);
