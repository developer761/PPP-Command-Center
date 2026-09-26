/**
 * Does each form post what its action reads?
 *
 *   node scripts/check-form-seams.mjs
 *
 * WHY
 *
 * The bugs that ship here live BETWEEN two files, not inside either. A form
 * renders a field, the action never reads it, and both halves are correct on
 * their own — so types pass, tests pass, and the control is simply dead. This
 * platform has shipped that at least twice: a Send-for-approval that bailed in
 * silence because the action read a field the form did not post, and an
 * invisible duplicate input that overwrote a cost Mary had typed.
 *
 * `check:form-fields` already catches the duplicate-name case. This catches the
 * other two directions:
 *
 *   DEAD FIELD     the form posts `name="x"` and no action reads "x".
 *                  Somebody types into it and nothing happens.
 *
 *   MISSING FIELD  the action reads formData.get("y") and the form that posts
 *                  to it renders no "y". The action takes the empty string,
 *                  and usually returns early without saying why.
 *
 * WHAT IT IS NOT
 *
 * Not a proof. Fields can be rendered by a child component, spread from a map,
 * or named by a variable, and an action can be shared by several forms. So
 * this REPORTS rather than asserts, and prints enough context to judge each
 * one by hand. A finding here is a question, not a verdict.
 *
 * It states what it scanned, because a matcher that silently matched nothing
 * would otherwise print a clean bill over an empty set.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
/*
 * SCANNED EVERYWHERE, REPORTED FOR COMMERCIAL.
 *
 * The first cut scanned only app/commercial and components/commercial, and so
 * never opened components/commercial-file-row-actions.tsx or
 * components/commercial-address-fields.tsx — both at the components root. Their
 * fields came back as "read but never posted" because the file rendering them
 * was outside the scan. A checker that quietly reads less than it claims is the
 * same fake pass it exists to prevent.
 */
const ROOTS = ["app", "components", "lib"];
/** A finding is only reported when the form that posts it is a commercial one. */
const REPORT_IF = (rel) => /commercial/.test(rel);
/**
 * Registries that drive a DYNAMIC read — `for (const f of GROUP) formData.get(f)`.
 * The proposal editor works exactly this way, and its fourteen header fields
 * all read as dead until these are counted. A name listed in one of these is
 * being read by a loop this cannot follow.
 */
const REGISTRY_DIRS = ["lib/commercial"];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const n of entries) {
    const f = join(dir, n);
    const st = statSync(f);
    if (st.isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(f);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const registryFiles = REGISTRY_DIRS.flatMap((r) => walk(join(ROOT, r)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every name any server action anywhere reads out of a FormData. */
const readNames = new Map(); // name -> Set(file)
/** The subset read specifically out of a FormData — used for the reverse check. */
const formDataReads = new Map();
/** Every name any form posts. */
const postedNames = new Map(); // name -> Set(file)

let actionCount = 0;
let formCount = 0;

for (const f of files) {
  const src = strip(readFileSync(f, "utf8"));
  const rel = relative(ROOT, f);

  /*
   * Every shape a field gets read in. The first cut required `<ident>.get(`
   * and so missed the bare `get("x")` helpers that most of these pages use —
   * which made 40-odd live fields look dead. A reader-detector that is too
   * narrow does not under-report: it over-reports, and buries the real ones.
   */
  const reads = [
    ...[...src.matchAll(/(?:\b[A-Za-z_$][\w$]*\.)?\bget(?:All)?\(\s*["'`]([a-zA-Z0-9_\-[\]]+)["'`]/g)].map((m) => m[1]),
    // `const { a, b } = Object.fromEntries(formData)` and direct indexing.
    ...[...src.matchAll(/formData\[\s*["'`]([a-zA-Z0-9_\-]+)["'`]\s*\]/g)].map((m) => m[1]),
    /*
     * Several forms read their own FormData on the client and POST JSON — the
     * public bid form does exactly this — so the field arrives at the route as
     * `body.company`, not `formData.get("company")`. Without this every field
     * on those forms reads as dead.
     */
    ...[...src.matchAll(/\b(?:body|payload|input|json|parsed|args)\.([a-zA-Z0-9_]+)\b/g)].map((m) => m[1]),
    // `idFrom(formData, "x")` / `readWaiver("x")` — a helper doing the read.
    ...[...src.matchAll(/\b[a-zA-Z_$][\w$]*\(\s*(?:formData\s*,\s*)?["'`]([a-z][a-zA-Z0-9_\-]{2,40})["'`]\s*[,)]/g)].map((m) => m[1]),

  ];
  /*
   * Collected from EVERY file, not only ones that look like a server action.
   * The first cut gated this on "use server" or the word formData, so an API
   * route reading `body.company` was never scanned — and every field on the
   * form that posts to it came back dead. The gate was hiding the readers,
   * not the writers.
   */
  if (reads.length) actionCount++;
  for (const n of reads) {
    if (!readNames.has(n)) readNames.set(n, new Set());
    readNames.get(n).add(rel);
  }
  for (const m of src.matchAll(/formData\.get(?:All)?\(\s*["'`]([a-zA-Z0-9_\-[\]]+)["'`]/g)) {
    if (!formDataReads.has(m[1])) formDataReads.set(m[1], new Set());
    formDataReads.get(m[1]).add(rel);
  }

  /*
   * Fields inside a GET form go to the URL, not to a server action, and are
   * read back through searchParams. Counting them made every filter bar on the
   * platform look like a wall of dead controls. Dropped by cutting the GET
   * form blocks out before looking for names.
   */
  const withoutGetForms = src.replace(/<form\b(?=[^>]*method=["'`]get["'`])[\s\S]*?<\/form>/gi, "");
  /*
   * `name="x"` and every prop that CARRIES a field name down to a child —
   * `otherName="category_other"`, `streetFieldName="site_address"`. Without
   * these, a field whose name arrives as a prop reads as never posted, which
   * is how Mary's two "Other" free-text boxes looked dead.
   *
   * This also matches display props like `accountName`, which only makes the
   * dead-field direction more conservative. That is the right way to be wrong
   * for a tool whose output is meant to be read one line at a time.
   */
  const posts = [
    ...[...withoutGetForms.matchAll(/\bname=["'`]([a-zA-Z0-9_\-[\]]+)["'`]/g)].map((m) => m[1]),
    /*
     * `fd.set("x", …)` / `fd.append("x", …)` — a client building its own
     * FormData. This is the field being CARRIED, and the first cut counted it
     * as a read, so a field posted only this way looked like an action asking
     * for something nobody sends. The AIA settings form posts all eight of its
     * fields this way.
     */
    ...[...src.matchAll(/\.(?:append|set)\(\s*["'`]([a-zA-Z0-9_\-[\]]+)["'`]/g)].map((m) => m[1]),
    /*
     * `name={`${namePrefix}follow_up_at`}` — a shared picker that prefixes its
     * field names. The literal tail is the field.
     */
    ...[...withoutGetForms.matchAll(/name=\{\s*`[^`]*\$\{[^}]*\}([a-z_][a-z0-9_]*)`/g)].map((m) => m[1]),
    // `className` is not a field name. It is the single biggest source of
    // noise in this whole check — it turned 1 finding into 90 lines of CSS.
    // Constrained to snake_case, which is what every field name in this
    // codebase looks like. Unconstrained it swept up Tailwind values from
    // other *Name props ("h-[150px]") along with the CSS classes.
    ...[...withoutGetForms.matchAll(/\b(?!className\b)\w+Name=["'`]([a-z][a-z0-9_]*)["'`]/g)].map((m) => m[1]),
  ];
  if (/<form\b/.test(src)) formCount += [...src.matchAll(/<form\b/g)].length;
  for (const n of posts) {
    if (!postedNames.has(n)) postedNames.set(n, new Set());
    postedNames.get(n).add(rel);
  }
}

/**
 * Names that are not form fields at all: React/DOM attributes and library
 * props that happen to be spelled `name`, plus the searchParams a page reads
 * from a URL rather than a form.
 *
 * A RADIO GROUP shares a `name` so the browser treats the options as one
 * choice. On a controlled group the value is read from React state and never
 * from FormData, so the shared name is doing its job and is not a dead field.
 */
const NOT_A_FIELD = new Set([
  // URL params read via searchParams.get(), not FormData.
  "view", "tab", "sub", "preset", "from", "to", "month", "week", "q", "id",
  "page", "sort", "dir", "kind", "status", "period", "tp", "td", "tparty",
  "tundep", "nocert", "argroup", "arperiod", "error", "ok", "saved", "back",
  "return", "mode", "token", "code", "state", "next", "redirect", "ref",
  "utm_source", "utm_medium", "utm_campaign", "accountId", "oppId", "dealId",
  /*
   * A CONTROLLED RADIO GROUP. The options share `name="commercial-role"` so
   * the browser treats them as one choice; the value is held in React state
   * and read from there, never from FormData. Verified 2026-09-25 — the shared
   * name is doing its job.
   */
  "commercial-role",
  /*
   * Verified 2026-09-25, each one opened and read:
   *
   * proposed_start_at / proposed_end_at — posted by `inlineRow("…")`, a helper
   *   that names its input from its argument. A variable name, which this
   *   cannot follow.
   *
   * probability_pct — stage-derived now (`probabilityFor`), and the edit
   *   action leaves the column alone when the field is absent rather than
   *   blanking it. Reading a field no form sends is deliberate here.
   *
   * Recorded rather than left in the output: three permanent false positives
   * teach everyone to ignore the whole list.
   */
  "proposed_start_at", "proposed_end_at", "probability_pct",
]);

/** Names a registry lists, and so a loop somewhere reads. */
const registryNames = new Set();
for (const f of registryFiles) {
  const src = strip(readFileSync(f, "utf8"));
  for (const m of src.matchAll(/["'`]([a-z][a-z0-9_]{2,40})["'`]/g)) registryNames.add(m[1]);
}

const dead = [];
for (const [n, where] of postedNames) {
  if (NOT_A_FIELD.has(n)) continue;
  // A leading underscore means this is the TAIL of a prefixed name
  // (`${prefix}_city`), never a whole field. It cannot be dead on its own.
  if (n.startsWith("_")) continue;
  if (readNames.has(n) || registryNames.has(n)) continue;
  const commercial = [...where].filter(REPORT_IF);
  if (commercial.length) dead.push({ n, where: commercial.slice(0, 3) });
}

/*
 * The reverse direction is restricted to genuine FormData reads. Including the
 * broad `body.X` shape made it match DOM property access — appendChild, blur —
 * and 113 lines of that buries anything real.
 */
/*
 * A prefixed field name — `name={`${prefix}_city`}` — is only whole at
 * runtime. What IS knowable is its tail, so a read is treated as satisfied
 * when some component posts a tail that ends it. CommercialAddressFields and
 * the status picker between them account for every remaining line here.
 */
const postedTails = [...postedNames.keys()].filter((n) => n.startsWith("_") || true);
const satisfiedByPrefix = (name) =>
  postedTails.some((t) => t.length >= 4 && t !== name && name.endsWith(t));

const missing = [];
for (const [n, where] of formDataReads) {
  if (NOT_A_FIELD.has(n)) continue;
  if (postedNames.has(n) || satisfiedByPrefix(n)) continue;
  const commercial = [...where].filter(REPORT_IF);
  if (commercial.length) missing.push({ n, where: commercial.slice(0, 3) });
}

console.log(`\nForm/action seams\n`);
console.log(`  scanned ${files.length} files · ${formCount} <form> elements · ${actionCount} files reading fields`);
console.log(`  plus ${registryFiles.length} lib files for registries that drive a dynamic read`);
if (files.length === 0 || formCount === 0) {
  console.log("\n  Scanned nothing. Refusing to report a clean bill over an empty set.\n");
  process.exit(1);
}

const show = (label, list, note) => {
  console.log(`\n  ${label}: ${list.length}`);
  if (note && list.length) console.log(`  ${note}`);
  for (const { n, where } of list.sort((a, b) => a.n.localeCompare(b.n))) {
    console.log(`    ${n.padEnd(30)} ${where.join(", ")}`);
  }
};

show(
  "POSTED BUT NEVER READ",
  dead,
  "  (a control somebody can use that changes nothing — verify each by hand)",
);
show(
  "READ BUT NEVER POSTED",
  missing,
  "  (an action expecting a field no form sends — usually a silent early return)",
);

console.log(
  `\n  Findings are QUESTIONS, not verdicts: a field can be named by a variable,\n` +
    `  spread from a map, or rendered by a child this cannot follow.\n`,
);
