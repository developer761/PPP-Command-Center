/**
 * Kate's Class A rules: reading her sheet, and choosing what the bot is told.
 *
 * She sent 44 of them on 2026-09-22 — 35 live, 9 retired — distilled from
 * grading Hatch's conversations. They are the standard the bot is written
 * against AND the standard raters mark against, which is the whole reason they
 * cannot stay in a spreadsheet somebody re-exports: the bot and the rater have
 * to be reading the same row.
 *
 * ── THE COLUMN THAT MUST NEVER REACH A MODEL ────────────────────────────
 *
 * One column is headed, in Kate's words: "Rating guidance [RATER ONLY — NEVER
 * give this to a bot]". It tells a human how to judge a breach, so handing it
 * to the model would teach it to argue with its own grader and to optimise for
 * what the rater looks at rather than for the customer.
 *
 * This file separates it at the point of parsing, into a different type that
 * goes into a different table. `forPrompt` below cannot reach it — not because
 * it chooses not to, but because the value is not in the object it is given.
 *
 * ── WHAT ACTUALLY FITS ──────────────────────────────────────────────────
 *
 * Measured on the real file:
 *
 *   statements only             3,745 chars    ~936 tokens
 *   statements + corrective     7,295 chars  ~1,824 tokens
 *   every bot-facing field     47,180 chars ~11,795 tokens
 *
 * So the whole rulebook in brief is affordable on every single turn, and the
 * full cards are not — 11.8k tokens per reply is a real cost at PPP's volume
 * and enough prose to drown the rest of the prompt. A rule the model will
 * never touch does not deserve four paragraphs beside one it breaches weekly.
 *
 * Pure. No database, no network.
 */
import { parseCsvRows } from "./csv";

/** Bot-safe. Every field here may appear in a prompt. */
export type ClassARule = {
  code: string;
  statement: string;
  ruleCard: string | null;
  correctiveAction: string | null;
  severity: "critical" | "mild" | null;
  status: "live" | "retired";
  phrasingOnly: boolean;
  binds: boolean;
  source: string | null;
  measuredBreaches: string | null;
  changeType: string | null;
  lastModified: string | null;
  lastReRated: string | null;
};

/**
 * RATER ONLY. Deliberately a separate type so it is not merely a field
 * somebody forgets to omit — a function handed a ClassARule cannot reach it.
 */
export type ClassARuleNotes = {
  code: string;
  ratingGuidance: string | null;
  history: string | null;
};

export type ParsedRules = {
  rules: ClassARule[];
  notes: ClassARuleNotes[];
  /** Rows that could not be read, with why. Never silently dropped. */
  problems: { row: number; why: string }[];
  /** Field names whose column was not in this sheet, so their values are
   *  defaults rather than anything Kate chose. The change log skips these. */
  absent: Set<string>;
};

/** Kate's headings are long and carry bracketed audience notes; match on the
 *  distinctive opening words rather than the whole string, which changes. */
const COLUMNS = {
  code: ["#"],
  statement: ["rule statement"],
  source: ["source"],
  binds: ["binds"],
  measuredBreaches: ["measured breaches"],
  ruleCard: ["the rule in detail"],
  correctiveAction: ["corrective action"],
  phrasingOnly: ["phrasing-only", "phrasing only"],
  history: ["history"],
  ratingGuidance: ["rating guidance"],
  lastModified: ["last modified"],
  changeType: ["change type"],
  lastReRated: ["last re-rated", "last re rated"],
  severity: ["severity"],
  status: ["status"],
} as const;

function columnIndex(headers: string[], candidates: readonly string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = norm.findIndex((h) => h.startsWith(c));
    if (i >= 0) return i;
  }
  return -1;
}

const text = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/** "Yes" / "Yes · PROHIBITION …" / "—" / "" */
function yesish(v: string | undefined): boolean {
  const t = (v ?? "").trim().toLowerCase();
  if (!t || t === "—" || t === "-" || t === "no") return false;
  return t.startsWith("yes");
}

/** "LIVE — port this" / "RETIRED — never tag, never build" / "BURNED …" */
export function statusOf(v: string | undefined): "live" | "retired" {
  const t = (v ?? "").trim().toLowerCase();
  // Anything not explicitly live is retired. A rule whose status nobody can
  // read must not reach a prompt on the strength of a typo.
  return t.startsWith("live") ? "live" : "retired";
}

export function severityOf(v: string | undefined): "critical" | "mild" | null {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "critical") return "critical";
  if (t === "mild") return "mild";
  return null;
}

/** Google Sheets writes these as YYYY-MM-DD; anything else is left alone. */
function dateOf(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/**
 * A REAL PHONE NUMBER MUST NOT REACH THE PROMPT, WHOEVER PUT IT THERE.
 *
 * Kate, 2026-09-24: "you can modify the example to remove the actual phone
 * number + email!" — so A22's read-back example was scrubbed to [PHONE] and
 * [EMAIL], and A22 was taken out of the PII sweep's allowlist because it no
 * longer needed excusing.
 *
 * Her 2026-09-25 export has "516-784-6046" and "tom@x.com" back in it. She
 * re-issues this sheet every time rules are merged or reworded, so a scrub
 * that lives only in the database is a scrub that lasts until the next
 * import. Doing it here means the file can say anything and the bot-facing
 * text still carries nothing.
 *
 * The example still teaches: the shape being taught is "read both values
 * back for a single yes", and [PHONE] and [EMAIL] show that as well as real
 * values do. A13's "12 Oak St" is an address, not a contact, and is a
 * textbook one — it is untouched here and stays the sweep's one exception.
 */
const A_PHONE = /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const AN_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;

export function scrubContacts(text: string | null): string | null {
  if (!text) return text;
  return text.replace(A_PHONE, "[PHONE]").replace(AN_EMAIL, "[EMAIL]");
}

export function parseClassARules(csv: string): ParsedRules {
  const rows = parseCsvRows(csv);
  if (!rows.length) return { rules: [], notes: [], problems: [{ row: 0, why: "the file is empty" }], absent: new Set() };

  const headers = rows[0];
  const at = Object.fromEntries(
    Object.entries(COLUMNS).map(([k, c]) => [k, columnIndex(headers, c)])
  ) as Record<keyof typeof COLUMNS, number>;

  const problems: { row: number; why: string }[] = [];
  for (const required of ["code", "statement", "status"] as const) {
    if (at[required] < 0) problems.push({ row: 0, why: `no column for ${required}` });
  }
  if (problems.length) return { rules: [], notes: [], problems, absent: new Set() };

  const rules: ClassARule[] = [];
  const notes: ClassARuleNotes[] = [];
  const seen = new Set<string>();

  rows.slice(1).forEach((r, i) => {
    const line = i + 2; // 1-based, and the header is line 1
    if (!r.some((c) => (c ?? "").trim())) return; // a blank spacer row

    const code = (r[at.code] ?? "").trim().toUpperCase();
    if (!code) { problems.push({ row: line, why: "no rule code" }); return; }
    // A duplicated code would overwrite a rule on import and silently change
    // what the bot is told.
    if (seen.has(code)) { problems.push({ row: line, why: `duplicate code ${code}` }); return; }

    const statement = (r[at.statement] ?? "").trim();
    const status = statusOf(r[at.status]);
    const severity = severityOf(r[at.severity]);

    // A live rule with no statement or no severity cannot be shown to anyone,
    // and the database CHECK would refuse it anyway. Reported, not dropped.
    if (status === "live" && !statement) { problems.push({ row: line, why: `${code} is live with no statement` }); return; }
    if (status === "live" && !severity) { problems.push({ row: line, why: `${code} is live with no severity` }); return; }

    seen.add(code);
    rules.push({
      code,
      // Scrubbed on the way in — see scrubContacts. These three are the
      // bot-facing fields; rater notes go to another table entirely.
      statement: scrubContacts(statement) ?? statement,
      ruleCard: at.ruleCard >= 0 ? scrubContacts(text(r[at.ruleCard])) : null,
      correctiveAction: at.correctiveAction >= 0 ? scrubContacts(text(r[at.correctiveAction])) : null,
      severity,
      status,
      phrasingOnly: at.phrasingOnly >= 0 ? yesish(r[at.phrasingOnly]) : false,
      binds: at.binds >= 0 ? yesish(r[at.binds]) : true,
      source: at.source >= 0 ? text(r[at.source]) : null,
      measuredBreaches: at.measuredBreaches >= 0 ? text(r[at.measuredBreaches]) : null,
      changeType: at.changeType >= 0 ? text(r[at.changeType]) : null,
      lastModified: at.lastModified >= 0 ? dateOf(r[at.lastModified]) : null,
      lastReRated: at.lastReRated >= 0 ? dateOf(r[at.lastReRated]) : null,
    });

    // The rater-only half, kept apart from the moment it is read.
    notes.push({
      code,
      ratingGuidance: at.ratingGuidance >= 0 ? text(r[at.ratingGuidance]) : null,
      history: at.history >= 0 ? text(r[at.history]) : null,
    });
  });

  /**
   * Columns this sheet did NOT carry.
   *
   * A parser that defaults a missing column is doing the right thing for the
   * bot and the wrong thing for the change log: the default is not a value
   * Kate chose, so diffing against it reports an edit nobody made. The 23
   * September sheet dropped binds and phrasing_only, and without this the
   * import recorded twelve "Binds the bot: no -> yes" changes that never
   * happened. See rule-diff.ts, which skips what this names.
   */
  const absent = new Set(
    Object.entries(at).filter(([, i]) => (i as number) < 0).map(([k]) => k)
  );

  return { rules, notes, problems, absent };
}

/** Which rules may be shown to the model at all. */
export function promptable(rules: ClassARule[]): ClassARule[] {
  return rules
    .filter((r) => r.status === "live" && r.binds && r.statement.trim())
    // Critical first, then by code, so the ordering is stable between turns
    // and the most expensive rules are read first.
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      return numberOf(a.code) - numberOf(b.code);
    });
}

/** "A12" → 12, so A9 sorts before A10 rather than after it. */
export function numberOf(code: string): number {
  const m = /(\d+)/.exec(code);
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * The rulebook, as the model sees it.
 *
 * Statement plus corrective action for every live binding rule — around 1,800
 * tokens for all 35, affordable on every turn, and complete. The full cards
 * are deliberately NOT here; see the note at the top of this file.
 *
 * Takes ClassARule, which structurally cannot carry the rater-only guidance.
 */
export function forPrompt(rules: ClassARule[]): string {
  const live = promptable(rules);
  if (!live.length) return "";

  // "What good looks like", NOT "Instead". Kate's corrective-action column is
  // written in the past tense for a RATER marking a finished conversation —
  // "gave no price, no ballpark and no range". Prefixed with "Instead:" that
  // reads as a garbled instruction; prefixed with this it reads as the
  // description of a passing reply, which is what it actually is.
  const line = (r: ClassARule) => {
    const fix = r.correctiveAction ? `\n   What good looks like: ${r.correctiveAction}` : "";
    return `${r.code}. ${r.statement}${fix}`;
  };

  const critical = live.filter((r) => r.severity === "critical");
  const mild = live.filter((r) => r.severity !== "critical");

  // Joined rather than filtered: a `.filter(Boolean)` here ate the blank line
  // between the heading and the first rule, so the whole section arrived at
  // the model as one unbroken wall.
  const parts = [
    "THE RULES YOU ARE GRADED AGAINST.",
    "Every one of these came from a real conversation that was marked wrong.",
    "",
    "BREAKING ANY OF THESE IS A SERIOUS FAILURE:",
    critical.map(line).join("\n"),
  ];
  if (mild.length) {
    parts.push("", "GET THESE RIGHT TOO:", mild.map(line).join("\n"));
  }
  return parts.join("\n");
}
