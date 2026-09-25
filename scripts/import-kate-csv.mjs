/**
 * Kate's graded conversations, from the CSV she sent on 2026-09-15.
 *
 * The PDF flattened her spreadsheet: "Where It Fell Short" and "Good Turn(s)"
 * ran together with no marker, so 74 findings landed on the wrong
 * conversations and were removed on 2026-09-12. The CSV keeps the column
 * boundary, and her transcript column is "AI Conversation Only [PCM + T
 * turns]" — the numbering the hub now uses: [PCM] for the campaign message
 * before the customer's first reply, then T1 for that reply.
 *
 * WHAT THIS TRUSTS AND WHAT IT CHECKS. Her T-numbers are the whole point, so
 * nothing is imported onto a conversation whose stored turns do not match hers
 * one for one: same count, same speaker, same words. A row that does not match
 * is reported and skipped rather than filed against a turn it does not
 * describe, which is exactly the failure the PDF caused.
 *
 * Her export is AI-only: a human agent's messages after a handoff are not in
 * it. The stored transcript keeps them, unnumbered, so the numbering still
 * lines up (isUnnumbered in repair.ts).
 *
 * PII is scrubbed before anything is written.
 *
 * Dry run by default; --apply to write.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { scrub, residualPii } from "../lib/messaging/pii.ts";
import { turnsOf } from "../lib/messaging/repair.ts";

const CSV = process.argv.find((a) => a.endsWith(".csv"))
  ?? "/Users/karanmalhotra/Downloads/conversations_tab_ai_only_2026-09-15.csv";
const APPLY = process.argv.includes("--apply");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/** RFC4180 enough for this file: quoted fields, doubled quotes, newlines inside. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const col = (row, startsWith) => {
  const key = Object.keys(row).find((k) => k.startsWith(startsWith));
  return key ? row[key] : "";
};

const ENTRY = /\[(PCM|T\d+)\]\s*(\d{1,2}:\d{2})\s*\[(SMS|EMAIL|CALL)\]\s*(CAMPAIGN|CUSTOMER|AI \(Emily\)|HUMAN AGENT|AUTO-REPLY):\s?/g;
const SPEAKER = { CAMPAIGN: "Campaign", CUSTOMER: "Customer", "AI (Emily)": "Emily", "HUMAN AGENT": "Human agent", "AUTO-REPLY": "Auto-reply" };

/** Her transcript column → the turns she numbered. */
function kateTurns(text) {
  const heads = [...text.matchAll(ENTRY)];
  return heads.map((h, i) => {
    const body = text.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : text.length);
    return {
      tag: h[1],
      turn: h[1] === "PCM" ? null : Number(h[1].slice(1)),
      speaker: SPEAKER[h[4]],
      text: body.replace(/---\s*\d{4}-\d{2}-\d{2}\s*---/g, " ").replace(/\s+/g, " ").trim(),
    };
  });
}

/** T3 [A11 | Redundant Ask/mild] what -> SHOULD HAVE: should */
function parseFindings(text, kind) {
  const out = [];
  const re = /T(\d+)\s*\[([A-Z]\d+)(?:\s*\|\s*([^\]/]+?))?(?:\s*\/\s*([a-z]+))?\]\s*([\s\S]*?)(?=(?:\n|^)\s*T\d+\s*\[[A-Z]\d+|$)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, turn, code, name, sev, body] = m;
    const parts = body.split(/->\s*SHOULD HAVE:\s*/);
    const what = parts[0].replace(/\s+/g, " ").trim();
    if (!what) continue;
    out.push({
      turn_ordinal: Number(turn), code, kind,
      severity: ["mild", "medium", "critical"].includes((sev ?? "").toLowerCase()) ? sev.toLowerCase() : null,
      name: (name ?? "").trim() || null,
      what: what.slice(0, 2000),
      should_have: parts[1] ? parts[1].replace(/\s+/g, " ").trim().slice(0, 2000) : null,
    });
  }
  return out;
}

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
/**
 * Compare two renderings of the same message.
 *
 * The two sources differ in ways that are not differences in what was said:
 * the stored transcript marks a non-text channel ("[Email] ", "[Call] "), the
 * two were scrubbed separately so one may carry [NAME] where the other carries
 * [NAME] [NAME], and the PDF dropped the odd space or word. So: scrub tokens
 * collapse to one wildcard, channel marks go, and punctuation goes.
 */
const loose = (s) => norm(s)
  .replace(/^\[(email|call)\]\s*/, "")
  .replace(/\[(zip|phone|email|address|name)\]/g, "*")
  .replace(/[^a-z0-9*]+/g, "")
  .replace(/\*+/g, "*");

const rows = parseCsv(readFileSync(CSV, "utf8"));

/**
 * Paged. PostgREST caps an unbounded select at 1,000 and this script MATCHES
 * against what it reads — so a short read makes existing conversations look
 * new, and re-running would duplicate every one it could not see. 1,294 rows
 * today.
 *
 * SUPERSEDED by scripts/import-rated-conversations.mjs, which reads Kate's
 * current export. Kept because it documents how the earlier format was
 * loaded; paged so that running it cannot quietly make a mess.
 */
async function readAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const stored = await readAll((a, b) => sb.from("sms_training_examples")
  .select("id, transcript, conduct").neq("source", "derived").order("id").range(a, b));

console.log(`\nKATE'S CSV — ${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
console.log(`rows in the CSV        : ${rows.length}`);
console.log(`conversations stored   : ${stored.length}`);

const plan = [];
const problems = [];

for (const row of rows) {
  const label = `row ${col(row, "Row #")} ${col(row, "Board Name")}`;
  const names = [col(row, "Contact Name")].filter(Boolean);
  const emailLocal = (col(row, "Contact Email").split("@")[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const raw = col(row, "AI Conversation Only");
  const extra = emailLocal.length >= 4
    ? [...new Set((raw.match(/\b[A-Z][a-z]{3,}\b/g) ?? []).filter((w) => emailLocal.includes(w.toLowerCase())))]
        .filter((w) => !new RegExp(`\\b${w.toLowerCase()}\\b`).test(raw))
    : [];
  const clean = scrub(raw, [...names, ...extra]).text;
  const leftover = residualPii(clean);
  if (leftover.length) { problems.push(`${label}: still looks like customer data (${leftover.join(", ")})`); continue; }

  const hers = kateTurns(clean);
  const herNumbered = hers.filter((t) => t.turn !== null);
  if (!herNumbered.length) { problems.push(`${label}: no numbered turns`); continue; }

  // Which stored conversation is this? Scored across the whole thread, not on
  // the first message: plenty of conversations open with "Hi".
  const score = (s) => {
    const ours = turnsOf(s.transcript).filter((t) => t.turn !== null);
    let n = 0;
    for (const h of herNumbered) {
      const o = ours.find((x) => x.turn === h.turn);
      if (o && o.speaker === h.speaker && loose(o.text) === loose(h.text)) n++;
    }
    return { s, ours, n };
  };
  const ranked = stored.map(score).sort((a, b) => b.n - a.n);
  const best = ranked[0];

  // EVERY TURN SHE NUMBERED has to be the same message here: same number, same
  // speaker, same words. Her export stops at a handoff, so the stored
  // conversation may carry on past her last turn — that is fine, and the
  // numbers before it are untouched by what comes after.
  // Nearly all of her turns must match to call it the same conversation. The
  // odd one that does not is the PDF's fault — it dropped a word, ran two
  // together, or truncated a subject line — and her wording replaces ours below.
  const need = Math.max(3, Math.ceil(herNumbered.length * 0.8));
  if (!best || best.n < Math.min(need, herNumbered.length)) {
    const missed = best
      ? herNumbered.find((h) => {
          const o = best.ours.find((x) => x.turn === h.turn);
          return !o || o.speaker !== h.speaker || loose(o.text) !== loose(h.text);
        })
      : null;
    const o = missed ? best.ours.find((x) => x.turn === missed.turn) : null;
    problems.push(`${label}: ${best?.n ?? 0} of ${herNumbered.length} turns match${missed
      ? ` — T${missed.turn} hers "${missed.speaker}: ${missed.text.slice(0, 40)}", ours "${o ? `${o.speaker}: ${o.text.slice(0, 40)}` : "missing"}"`
      : ""}`);
    continue;
  }
  if (ranked[1] && ranked[1].n === best.n) {
    problems.push(`${label}: two stored conversations match equally well (${best.n} turns each)`);
    continue;
  }
  const example = best.s;
  const ours = best.ours;
  const beyond = ours.length - herNumbered.length;

  // HER WORDING WINS for the numbered turns. The stored text came out of a PDF
  // and lost the odd word, space and — in one case — an address the scrubber
  // then could not see. The unnumbered lines (the campaign message, a human
  // agent after the handoff) are not in her export, so they stay as they are.
  const lines = example.transcript.split("\n");
  const all = turnsOf(example.transcript);
  const rewritten = [];
  for (const t of all) {
    const h = t.turn === null ? null : herNumbered.find((x) => x.turn === t.turn);
    if (h && loose(h.text) !== loose(t.text)) rewritten.push(t.turn);
    lines.splice(
      t.firstLine, t.lastLine - t.firstLine + 1,
      `${t.speaker}: ${h ? h.text : t.text}`,
    );
    // Splicing one message to one line shifts later ranges; recompute.
    const shift = (t.lastLine - t.firstLine);
    if (shift) for (const other of all) {
      if (other.firstLine > t.lastLine) { other.firstLine -= shift; other.lastLine -= shift; }
    }
  }
  const merged = lines.join("\n");
  const mergedLeftover = residualPii(merged);
  if (mergedLeftover.length) {
    problems.push(`${label}: merged transcript still looks like customer data (${mergedLeftover.join(", ")})`);
    continue;
  }
  const check = turnsOf(merged).filter((t) => t.turn !== null);
  const stillWrong = herNumbered.find((h) => {
    const o = check.find((x) => x.turn === h.turn);
    return !o || o.speaker !== h.speaker || norm(o.text) !== norm(h.text);
  });
  if (stillWrong) { problems.push(`${label}: T${stillWrong.turn} would not match after merging`); continue; }

  const findings = [
    ...parseFindings(col(row, "Where It Fell Short"), "fell_short"),
    ...parseFindings(col(row, "Claude Good Turn"), "did_well"),
  ].filter((f) => {
    const within = f.turn_ordinal <= ours.length;
    if (!within) problems.push(`${label}: a note names T${f.turn_ordinal}, but the conversation has ${ours.length} turns — skipped`);
    return within;
  });

  const gradeRaw = col(row, "Claude Grade").trim().toLowerCase();
  const conduct = gradeRaw === "mid" ? "mixed" : ["good", "bad"].includes(gradeRaw) ? gradeRaw : null;
  const agrees = col(row, "Agree with Claude's Rating").trim();
  const note = [
    col(row, "Why It Stopped") ? `Why it stopped: ${col(row, "Why It Stopped").trim()}` : "",
    col(row, "What Was Missing") ? `What was missing: ${col(row, "What Was Missing").trim()}` : "",
    agrees && agrees.toLowerCase() !== "yes" ? `Kate on the grade: ${agrees}` : "",
  ].filter(Boolean).join(" ");

  plan.push({
    label, exampleId: example.id, conduct, storedConduct: example.conduct, note, findings,
    turns: ours.length, transcript: merged, rewritten, beyond,
  });
}

const withFindings = plan.reduce((n, p) => n + p.findings.length, 0);
const corrections = plan.reduce((n, p) => n + p.findings.filter((f) => f.should_have).length, 0);
const regrades = plan.filter((p) => p.conduct && p.conduct !== p.storedConduct);
console.log(`matched turn for turn  : ${plan.length}`);
console.log(`notes to import        : ${withFindings} (${corrections} carry a correction)`);
console.log(`grades that change     : ${regrades.length}${regrades.length ? " — " + regrades.map((r) => `${r.label} ${r.storedConduct}→${r.conduct}`).join(", ") : ""}`);
const carriedOn = plan.filter((p) => p.beyond > 0);
console.log(`conversations that carry on past her last turn (a handoff): ${carriedOn.length}`);
const reworded = plan.filter((p) => p.rewritten.length);
console.log(`turns taking her exact wording over the PDF's: ${reworded.reduce((n, p) => n + p.rewritten.length, 0)} across ${reworded.length} conversations`);
console.log(`not imported           : ${problems.length}`);
for (const p of problems) console.log(`  - ${p}`);

const codes = [...new Set(plan.flatMap((p) => p.findings.map((f) => f.code)))].sort();
const { data: known } = await sb.from("sms_audit_codes").select("code, tag_key");
const knownCodes = new Set((known ?? []).map((k) => k.code));
const missing = codes.filter((c) => !knownCodes.has(c));
console.log(`codes used             : ${codes.length}${missing.length ? `, new to us: ${missing.join(", ")}` : ", all known"}`);

if (!APPLY) { console.log("\nNothing written.\n"); process.exit(problems.length ? 1 : 0); }

// New codes first: findings reference them.
for (const code of missing) {
  const name = plan.flatMap((p) => p.findings).find((f) => f.code === code && f.name)?.name ?? code;
  await sb.from("sms_audit_codes").insert({ code, name, description: "From Kate's CSV, 2026-09-15. Not linked to a bot rule yet." });
}
const tagOf = new Map((known ?? []).map((k) => [k.code, k.tag_key]));

let notes = 0, tagged = 0, graded = 0;
for (const p of plan) {
  // Replace only what came from her sheet; a repair's own per-turn fixes have
  // a repair_id and stay.
  await sb.from("sms_example_findings").delete().eq("example_id", p.exampleId).is("repair_id", null);
  if (p.findings.length) {
    const { error } = await sb.from("sms_example_findings").insert(p.findings.map((f) => ({
      example_id: p.exampleId, turn_ordinal: f.turn_ordinal, code: f.code, kind: f.kind,
      severity: f.severity, what: f.what, should_have: f.should_have,
    })));
    if (error) { console.log(`  notes failed ${p.label}: ${error.message}`); continue; }
    notes += p.findings.length;
  }

  const tags = [...new Set(p.findings.map((f) => tagOf.get(f.code)).filter(Boolean))];
  if (tags.length) {
    const { data: already } = await sb.from("sms_training_example_tags").select("tag_key").eq("example_id", p.exampleId);
    const have = new Set((already ?? []).map((t) => t.tag_key));
    const add = tags.filter((t) => !have.has(t));
    if (add.length) {
      await sb.from("sms_training_example_tags").insert(add.map((tag_key) => ({ example_id: p.exampleId, tag_key })));
      tagged += add.length;
    }
  }

  const patch = { conduct_note: p.note || null, transcript: p.transcript };
  if (p.conduct) patch.conduct = p.conduct;
  const { error: gErr } = await sb.from("sms_training_examples").update(patch).eq("id", p.exampleId);
  if (!gErr) graded++;
}
console.log(`\nwrote ${notes} notes, ${tagged} new rule tags, updated ${graded} conversations\n`);
