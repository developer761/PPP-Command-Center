/**
 * Loading the standing answers from a spreadsheet.
 *
 * ── WHY THIS IS WORTH BUILDING ──────────────────────────────────────────
 *
 * Roughly 25 answers per workspace, one row at a time, one workspace at a
 * time, with the form collapsing after every save. Costed from the real
 * screen: about 555 clicks for 15 workspaces and 1,180 for 32 — two to three
 * hours if the text is already written, closer to six at 32. And that is the
 * FIRST pass. The per-workspace answers are the ones most likely to change,
 * because service areas change, so the cost recurs.
 *
 * Kate already keeps this content in a spreadsheet. The import turns a day
 * into ten minutes and makes re-running it free, which is the part that
 * matters more.
 *
 * ── WHAT THE FILE LOOKS LIKE ────────────────────────────────────────────
 *
 *   question, answer                     -> shared by every workspace
 *   workspace, question, answer          -> that workspace only
 *
 * One file may contain both: a row with no workspace cell is shared. That is
 * the whole format, because a format somebody has to read instructions for is
 * a format they will get wrong at row 300.
 *
 * ── EVERY ROW IS CHECKED THE WAY A TYPED ONE IS ─────────────────────────
 *
 * These are sentences the BOT says as PPP, so a CSV is not a side door around
 * checkFaq. A1 (never a price), A18 (never name another company), the length
 * ceiling, and — for shared rows — the location-bound refusal all run here,
 * per row, before anything is written. An import that bypassed them would put
 * a service area in front of fifteen regions in one click, which is the exact
 * harm the shared tier was designed around.
 *
 * Pure. Parses, matches, checks and reports — the caller writes.
 */
import { parseCsv, matchHeader } from "./csv";
import { checkFaq } from "./workspace-faq";

const QUESTION_HEADERS = ["question", "q", "customer question", "asks", "prompt"];
const ANSWER_HEADERS = ["answer", "a", "reply", "response", "what we say"];
const WORKSPACE_HEADERS = ["workspace", "sub account", "sub_account", "account", "region", "location", "market"];

/**
 * Comfortably above 32 workspaces × 25 answers, comfortably below a
 * serverless timeout. Exported from HERE rather than from the write module,
 * which is "use server" and may export only async functions — a plain const
 * there silently drops every export in the module, and tsc cannot see it.
 */
export const MAX_FAQ_IMPORT_ROWS = 1500;

export type FaqImportRow = {
  /** The workspace NAME as written in the file, or null for a shared row. */
  workspaceName: string | null;
  /** Resolved against the real workspaces. Null on a shared row or no match. */
  workspaceId: string | null;
  question: string;
  answer: string;
  /** Which line of the file, so a problem can be pointed at. */
  line: number;
  /** Why this row cannot be imported, if it cannot. */
  problem: string | null;
};

export type FaqImportPreview = {
  rows: FaqImportRow[];
  usable: number;
  unusable: number;
  /** Shared rows among the usable ones — the ones that reach every workspace. */
  shared: number;
  /** Rows that would replace an answer already held, rather than add one. */
  replacing: number;
  duplicates: number;
  /**
   * Rows past MAX_FAQ_IMPORT_ROWS that were not read at all.
   *
   * Reported because the alternative is what this used to do: slice silently,
   * compute every count from the slice, and tell somebody who pasted 1,700
   * answers that 1,500 were saved — a number that differs from no expectation
   * they hold, so 200 answers vanish with nothing anywhere disagreeing. The
   * opt-out importer already refuses with a count rather than trimming; this
   * at least says how many it did not look at.
   */
  ignoredBeyondLimit: number;
  detectedHeaders: { question: string | null; answer: string | null; workspace: string | null };
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Read the file and say exactly what would happen, without doing any of it.
 *
 * `workspaces` and `existing` come from the database so the preview can
 * resolve names and say which rows REPLACE rather than add. A preview that
 * cannot tell those apart is not a preview — "312 rows will be imported"
 * hides that 200 of them overwrite answers somebody wrote last week.
 */
export function buildFaqImportPreview(text: string, ctx: {
  workspaces: { id: string; name: string }[];
  /** What is already held: workspaceId (or null for shared) + question. */
  existing: { workspaceId: string | null; question: string }[];
}): FaqImportPreview {
  const { headers, rows } = parseCsv(text);
  const qCol = matchHeader(headers, QUESTION_HEADERS);
  const aCol = matchHeader(headers, ANSWER_HEADERS);
  const wCol = matchHeader(headers, WORKSPACE_HEADERS);

  const byName = new Map(ctx.workspaces.map((w) => [norm(w.name), w.id]));
  const held = new Set(ctx.existing.map((e) => `${e.workspaceId ?? ""}::${norm(e.question)}`));

  const seen = new Set<string>();
  let duplicates = 0;
  let replacing = 0;

  const out: FaqImportRow[] = rows.slice(0, MAX_FAQ_IMPORT_ROWS).map((r, i) => {
    const line = i + 2; // 1-indexed, plus the header row
    const question = (qCol ? (r[qCol] ?? "") : "").trim();
    const answer = (aCol ? (r[aCol] ?? "") : "").trim();
    const workspaceName = wCol ? ((r[wCol] ?? "").trim() || null) : null;

    const base: FaqImportRow = {
      workspaceName, workspaceId: null, question, answer, line, problem: null,
    };

    if (!qCol || !aCol) {
      return { ...base, problem: "the file needs a question column and an answer column" };
    }
    if (!question && !answer) return { ...base, problem: "the row is empty" };
    if (!question) return { ...base, problem: "no question" };
    if (!answer) return { ...base, problem: "no answer" };

    let workspaceId: string | null = null;
    if (workspaceName) {
      workspaceId = byName.get(norm(workspaceName)) ?? null;
      if (!workspaceId) {
        /**
         * NOT silently treated as shared. A typo in a workspace name would
         * otherwise promote one region's answer into every region — the
         * single worst thing this importer could do, and it would look like
         * a successful import.
         */
        return { ...base, problem: `no workspace called "${workspaceName}"` };
      }
    }

    const shared = workspaceId === null;
    const problems = checkFaq({ question, answer, shared });
    if (problems.length) {
      return { ...base, workspaceId, problem: problems.map((p) => p.why).join("; ") };
    }

    // Within the file itself. Two rows answering one question for one
    // workspace is the "two rows disagree forever" failure arriving by CSV.
    const key = `${workspaceId ?? ""}::${norm(question)}`;
    if (seen.has(key)) {
      duplicates++;
      return { ...base, workspaceId, problem: "the same question appears earlier in this file" };
    }
    seen.add(key);

    if (held.has(key)) replacing++;
    return { ...base, workspaceId, problem: null };
  });

  const usable = out.filter((r) => !r.problem);
  return {
    rows: out,
    usable: usable.length,
    unusable: out.length - usable.length,
    shared: usable.filter((r) => r.workspaceId === null).length,
    replacing,
    duplicates,
    ignoredBeyondLimit: Math.max(0, rows.length - MAX_FAQ_IMPORT_ROWS),
    detectedHeaders: { question: qCol, answer: aCol, workspace: wCol },
  };
}

/** Only the rows that would actually be written. */
export function toFaqRecords(preview: FaqImportPreview): {
  workspaceId: string | null; question: string; answer: string;
}[] {
  return preview.rows
    .filter((r) => !r.problem)
    .map((r) => ({ workspaceId: r.workspaceId, question: r.question, answer: r.answer }));
}
