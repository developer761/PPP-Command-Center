/**
 * Turn Kate's conversation export into training examples.
 *
 * Pure: text in, a preview out. Nothing is written until somebody has looked
 * at the preview and pressed the button, because this is customer conversation
 * data and an import that silently does the wrong thing is expensive to undo.
 */
import { parseCsv, matchHeader } from "./csv";
import { scrub, residualPii, type PiiKind } from "./pii";

/** Header names Kate's export might plausibly use. */
const COLUMNS = {
  transcript: ["transcript", "conversation", "messages", "body", "text", "thread"],
  grade:      ["grade", "rating", "rated", "quality", "score", "good bad", "assessment"],
  outcome:    ["outcome", "disposition", "result", "end state", "status"],
  name:       ["customer name", "contact name", "name", "hatch contact name"],
  workspace:  ["workspace", "sub account", "account", "location"],
  date:       ["date", "created", "conversation date", "opt out date"],
};

export type GradeMeaning = "conduct" | "outcome";

export type PreviewRow = {
  line: number;
  transcript: string;
  scrubbed: string;
  grade: string | null;
  conduct: "good" | "mixed" | "bad" | null;
  outcome: string | null;
  workspace: string | null;
  piiFound: { kind: PiiKind; count: number }[];
  residual: PiiKind[];
  problems: string[];
};

export type ImportPreview = {
  headers: string[];
  detected: Partial<Record<keyof typeof COLUMNS, string>>;
  rows: PreviewRow[];
  usable: number;
  duplicates: number;
  ragged: number;
  /** Distinct grade values seen, so the UI can show what it is working with
   *  rather than assuming good/mixed/bad. */
  gradeValues: string[];
};

const CONDUCT: Record<string, "good" | "mixed" | "bad"> = {
  good: "good", great: "good", positive: "good", pass: "good", "1": "good",
  mixed: "mixed", ok: "mixed", okay: "mixed", average: "mixed", neutral: "mixed", "2": "mixed",
  bad: "bad", poor: "bad", negative: "bad", fail: "bad", "3": "bad",
};

/**
 * Build the preview.
 *
 * `gradeMeaning` is the question nobody has answered yet: do Kate's good/mixed/
 * bad grades describe how the conversation was HANDLED, or whether it BOOKED?
 * They are different signals and they disagree — a well-run conversation can
 * lose an unqualified lead. Trained on outcome alone the model imitates luck.
 * So the caller must say which, and the import puts the grade in the matching
 * column rather than guessing.
 */
export function buildPreview(csvText: string, gradeMeaning: GradeMeaning): ImportPreview {
  const { headers, rows, ragged } = parseCsv(csvText);

  const detected: ImportPreview["detected"] = {};
  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const found = matchHeader(headers, COLUMNS[key]);
    if (found) detected[key] = found;
  }

  const seen = new Set<string>();
  let duplicates = 0;
  const gradeValues = new Set<string>();
  const out: PreviewRow[] = [];

  rows.forEach((r, i) => {
    const problems: string[] = [];
    const transcript = detected.transcript ? (r[detected.transcript] ?? "") : "";
    const gradeRaw = detected.grade ? (r[detected.grade] ?? "").trim() : "";
    const name = detected.name ? (r[detected.name] ?? "") : "";
    const workspace = detected.workspace ? (r[detected.workspace] ?? "") : null;
    if (gradeRaw) gradeValues.add(gradeRaw);

    if (!transcript.trim()) problems.push("no transcript");
    if (!gradeRaw) problems.push("no grade");

    // Dedupe on the transcript itself. Kate's opt-out export had the same
    // event repeated many times, so assuming rows are distinct is unsafe.
    const key = transcript.trim().toLowerCase();
    if (key && seen.has(key)) { duplicates++; problems.push("duplicate of an earlier row"); }
    if (key) seen.add(key);

    const s = scrub(transcript, name ? [name] : []);
    const residual = residualPii(s.text);
    if (residual.length) problems.push(`possible ${residual.join(" and ")} left after scrubbing`);

    const mapped = CONDUCT[gradeRaw.toLowerCase()] ?? null;
    if (gradeRaw && !mapped && gradeMeaning === "conduct") {
      problems.push(`grade "${gradeRaw}" is not one of good / mixed / bad`);
    }

    out.push({
      line: i + 2, // +1 for the header, +1 for 1-indexing
      transcript,
      scrubbed: s.text,
      grade: gradeRaw || null,
      conduct: gradeMeaning === "conduct" ? mapped : null,
      outcome: gradeMeaning === "outcome" ? (gradeRaw || null) : (detected.outcome ? r[detected.outcome] || null : null),
      workspace,
      piiFound: s.found,
      residual,
      problems,
    });
  });

  return {
    headers,
    detected,
    rows: out,
    usable: out.filter((r) => r.problems.length === 0).length,
    duplicates,
    ragged: ragged.length,
    gradeValues: [...gradeValues].sort(),
  };
}
