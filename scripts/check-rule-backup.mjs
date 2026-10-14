/**
 * WHICH OF KATE'S RULES HAVE CODE BEHIND THEM, AND WHICH ARE THE MODEL'S WORD.
 *
 *   node --env-file=.env.local scripts/check-rule-backup.mjs
 *
 * READ ONLY. Writes nothing.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * Every live binding rule reaches the model: forPrompt sends all 37 on every
 * turn. So no rule is "unimplemented" in the sense of the model never having
 * been told.
 *
 * What differs is whether anything CHECKS. Some rules have deterministic
 * backup — a parser, a validator, a guard in the renderer — that holds even
 * when the model has an off turn. Others are the model's judgment alone.
 *
 * Both are legitimate. "Acknowledge a personal disclosure before carrying on"
 * (A34) is exactly the kind of judgment a model is good at and a regex is
 * terrible at; writing code for it would make the bot worse. "Neither a
 * project timeline nor a time the customer can TALK is appointment
 * availability" (A39) is the opposite: a parser decides it, so the parser has
 * to know.
 *
 * ── THE FAILURE THIS EXISTS TO MAKE VISIBLE ─────────────────────────────
 *
 * On 2026-10-13, A39 was in the prompt and availability.ts contradicted it.
 * The model was told a talk-time is not availability; availabilityGap banked
 * "I can talk Tuesday afternoon" as a complete appointment slot anyway. Code
 * silently overriding a rule the model was following is worse than no
 * implementation, because everything looks correct from both ends.
 *
 * That is not automatically detectable in general. What IS detectable, and
 * what this prints, is which rules have code near them at all — so a rule
 * that OWNS a deterministic decision can be checked by a person for whether
 * the code agrees with it.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await sb.from("sms_class_a_rules")
  .select("code, short_name, statement, severity, status, binds").order("code");
if (error) {
  console.error(`COULD NOT CHECK: ${error.message}`);
  console.error("This is NOT a pass.");
  process.exit(2);
}

const live = (data ?? []).filter((r) => String(r.status ?? "").toLowerCase() === "live" && r.binds);

/** Source that can ENFORCE something, as opposed to source that tests it. */
const enforcing = execSync("git ls-files 'lib/**/*.ts'", { encoding: "utf8" })
  .trim().split("\n").filter(Boolean)
  .map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");

/** Source that CHECKS: the harnesses and the suite. */
const checking = execSync("git ls-files '__tests__/**' 'scripts/**'", { encoding: "utf8" })
  .trim().split("\n").filter(Boolean)
  .map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");

const rows = live.map((r) => {
  const re = new RegExp(`\\b${r.code}\\b`, "g");
  return {
    code: r.code,
    severity: r.severity ?? "?",
    name: String(r.short_name ?? r.statement ?? "").replace(/\s+/g, " ").slice(0, 46),
    inCode: (enforcing.match(re) ?? []).length,
    inChecks: (checking.match(re) ?? []).length,
  };
});

const promptOnly = rows.filter((r) => r.inCode === 0);
const backed = rows.filter((r) => r.inCode > 0);

console.log(`\nKATE'S LIVE BINDING RULES — ${live.length}, all of them in the model's prompt\n`);

console.log(`  ${backed.length} have deterministic code behind them:\n`);
for (const r of backed.sort((a, b) => b.inCode - a.inCode)) {
  console.log(`    ${r.code.padEnd(5)} ${String(r.severity).padEnd(9)} code:${String(r.inCode).padStart(3)}  checks:${String(r.inChecks).padStart(3)}  ${r.name}`);
}

console.log(`\n  ${promptOnly.length} are the model's judgment alone — no code mentions them:\n`);
for (const r of promptOnly) {
  console.log(`    ${r.code.padEnd(5)} ${String(r.severity).padEnd(9)} checks:${String(r.inChecks).padStart(3)}  ${r.name}`);
}

console.log(
  `\n  Prompt-only is NOT a defect. A34 ("acknowledge a personal disclosure")`
  + `\n  is judgment a model does well and a regex does badly.`
  + `\n`
  + `\n  The question to ask of each one is narrower: does this rule decide`
  + `\n  something DETERMINISTIC code also decides? If so the code has to agree`
  + `\n  with it. A39 sat in this list while availability.ts contradicted it,`
  + `\n  and a talk-time was banked as a bookable appointment slot.\n`
);
process.exit(0);
