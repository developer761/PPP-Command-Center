/**
 * How the training and rules screens count and word things.
 *
 * Pure, so the numbers on three screens come from one place and can be
 * tested without a database. Production walkthrough 2026-10-16: the hub said
 * "152 to judge", the grader "1239 still need a grade or a rule", and the
 * rated list "All 1291" over tabs adding up to 1,139. All three were right
 * and none said what it was counting.
 */

/* ───────────────────────── the grading backlog ───────────────────────── */

export type Backlog<T> = {
  /** In the order to grade them: ungraded first, then graded with no rule. */
  queue: T[];
  /** No grade at all. */
  ungraded: number;
  /** Graded (usually from Kate's sheet) but no rule picked, so it teaches nothing yet. */
  noRule: number;
};

/**
 * What is left to grade.
 *
 * Ungraded first, as nextToGrade's comment always said; the code took them in
 * import order, so the first thing the grader showed was a conversation that
 * already had a grade.
 */
export function gradingBacklog<T extends { conduct: string | null; tags: string[] }>(rows: T[]): Backlog<T> {
  const ungraded = rows.filter((r) => !r.conduct);
  const noRule = rows.filter((r) => !!r.conduct && r.tags.length === 0);
  return { queue: [...ungraded, ...noRule], ungraded: ungraded.length, noRule: noRule.length };
}

/** "152 not graded · 1,087 graded, no rule picked", leaving out a zero half. */
export function backlogLabel(b: { ungraded: number; noRule: number }): string {
  const parts = [
    b.ungraded > 0 && `${b.ungraded.toLocaleString("en-US")} not graded`,
    b.noRule > 0 && `${b.noRule.toLocaleString("en-US")} graded, no rule picked`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing left to grade";
}

/* ─────────────────────────── the rule picker ─────────────────────────── */

export type PickerCode = {
  code: string;
  name: string;
  description: string | null;
  tag_key: string | null;
};

/**
 * Notes written for us in the description column, not for whoever grades.
 * "NEEDS KATE: overlaps A21/A23" is a question to Kate, and showing it in the
 * picker made it read like the rule's meaning.
 */
export function graderDescription(description: string | null): string {
  const d = (description ?? "").trim();
  return /^NEEDS KATE\b/i.test(d) ? "" : d;
}

/** A code is retired when its rule in Kate's sheet is. */
export function isRetiredCode(code: string, retired: ReadonlySet<string>): boolean {
  return retired.has(code.toUpperCase());
}

/* ─────────────────────────── a rule's sheet text ─────────────────────────── */

/**
 * Kate's sheet cells, readable.
 *
 * The import keeps her cells as they are, which is right for the record, but
 * on screen "||" is a cell-paragraph marker, the leading 🔴/⚠️ is her
 * spreadsheet's way of saying "important" (every paragraph on the page is
 * already the rule), and "Already in Karan's tone_rules." is a note about our
 * code. Returned as paragraphs; the stored text is untouched.
 */
export function sheetParagraphs(text: string | null): string[] {
  if (!text) return [];
  return text
    .split(/\s*\|\|\s*/)
    .map((p) => p
      .replace(/^[\s\p{Extended_Pictographic}️]+/u, "")
      // Provenance about our implementation, not about the rule.
      .replace(/(^|\s)Already in [^.]*tone_rules\.\s*/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim())
    .filter(Boolean);
}

/* ──────────────────────────────── paging ──────────────────────────────── */

export type Page<T> = { rows: T[]; page: number; pages: number; from: number; to: number; total: number };

/** One page of a list, 1-based, with an out-of-range page clamped rather than empty. */
export function pageOf<T>(rows: T[], page: number, size: number): Page<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (p - 1) * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: p, pages, from: total ? start + 1 : 0, to: start + slice.length, total };
}
