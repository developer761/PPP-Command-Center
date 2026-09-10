/**
 * Kate's conversation audit sheet, as a format this system reads and writes.
 *
 * She sent hers on 2026-09-10 and asked whether the hub needs adjusting to
 * match. It does, in one way that matters:
 *
 *   Where it fell short: T3 [A21 | Misc Awkward/mild] Said '...' in one
 *                        sentence. -> SHOULD HAVE: kept it short and natural
 *   Good Turns:          T3 [A6] Customer asked what it would cost — offsite
 *                        fired immediately
 *
 * THE SAME TURN APPEARS IN BOTH. T3 was clumsy AND right — it fired the
 * off-site quote immediately, which is what should happen, and said it badly.
 * A single verdict per turn cannot express that, so grading here carries two
 * independent notes rather than one rating. Kate's model is better than the
 * one this had and this adopts hers.
 *
 * "-> SHOULD HAVE:" is also hers and is the most valuable field in the sheet:
 * a correction is what makes an example teach, where a complaint only marks
 * something as bad.
 *
 * Pure. Formatting and parsing only.
 */

export type AuditTurn = {
  ordinal: number;
  /** CAMPAIGN, CUSTOMER or the agent's own name. */
  speaker: string;
  channel: "SMS" | "EMAIL";
  text: string;
  at?: string | null;
  /** What it got wrong, and what it should have done instead. */
  shortfall?: { code?: string | null; what: string; shouldHave?: string | null } | null;
  /** What it got right. Independent of the above — a turn can be both. */
  didWell?: { code?: string | null; why: string } | null;
};

export type AuditSheet = {
  title?: string | null;
  date?: string | null;
  overall: "good" | "mid" | "bad" | null;
  turns: AuditTurn[];
};

const pad = (n: number) => String(n).padStart(2, "0");

function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The sheet, in her layout.
 *
 * Written to be pasted back into the same spreadsheet it came from, so the
 * hub and the audit are one artefact rather than two that have to be
 * reconciled by hand.
 */
export function formatAuditSheet(sheet: AuditSheet): string {
  const lines: string[] = [];
  if (sheet.title) lines.push(sheet.title, "");

  lines.push("THE TRANSCRIPT");
  let lastDay: string | null = null;
  for (const t of sheet.turns) {
    const day = dayOf(t.at) ?? sheet.date ?? null;
    if (day && day !== lastDay) { lines.push(`--- ${day} ---`); lastDay = day; }
    const time = timeOf(t.at);
    lines.push(`[${t.ordinal}] ${time ? time + " " : ""}[${t.channel}] ${t.speaker}: ${t.text}`);
  }

  lines.push("", "THE RATINGS", "");
  lines.push(`Overall rating: ${sheet.overall ?? "not rated"}`);

  const short = sheet.turns.filter((t) => t.shortfall?.what?.trim());
  const good = sheet.turns.filter((t) => t.didWell?.why?.trim());

  lines.push("", "Where it fell short:");
  if (!short.length) lines.push("  none noted");
  for (const t of short) {
    const code = t.shortfall!.code ? ` [${t.shortfall!.code}]` : "";
    const should = t.shortfall!.shouldHave?.trim()
      ? ` -> SHOULD HAVE: ${t.shortfall!.shouldHave.trim()}`
      : "";
    lines.push(`  T${t.ordinal}${code} ${t.shortfall!.what.trim()}${should}`);
  }

  lines.push("", "Good Turns:");
  if (!good.length) lines.push("  none noted");
  for (const t of good) {
    const code = t.didWell!.code ? ` [${t.didWell!.code}]` : "";
    lines.push(`  T${t.ordinal}${code} ${t.didWell!.why.trim()}`);
  }

  return lines.join("\n");
}

/** One row per turn, for a spreadsheet rather than a document. */
export function formatAuditCsv(sheet: AuditSheet): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = [
    ["turn", "speaker", "channel", "message", "overall", "fell_short_code", "fell_short", "should_have", "good_code", "did_well"]
      .map(esc).join(","),
  ];
  for (const t of sheet.turns) {
    rows.push([
      String(t.ordinal), t.speaker, t.channel, t.text,
      sheet.overall ?? "",
      t.shortfall?.code ?? "", t.shortfall?.what ?? "", t.shortfall?.shouldHave ?? "",
      t.didWell?.code ?? "", t.didWell?.why ?? "",
    ].map(esc).join(","));
  }
  return rows.join("\n");
}

/**
 * The transcript alone, in the plain form the training corpus stores.
 *
 * Deliberately without the ratings: the corpus holds what was said, and the
 * grader's reason lives in its own column where it can be counted.
 */
export function transcriptOnly(sheet: AuditSheet): string {
  return sheet.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

/**
 * Kate's overall wording, mapped to what the corpus stores.
 *
 * She says "mid"; the column says "mixed". Same thing, and translating here
 * rather than asking her to change her sheet is the right direction for that
 * to travel.
 */
export function conductFor(overall: AuditSheet["overall"]): "good" | "mixed" | "bad" | null {
  if (overall === "mid") return "mixed";
  return overall;
}

/** Every note on the sheet, as one reason a corpus row can carry. */
export function reasonFrom(sheet: AuditSheet): string | null {
  const parts: string[] = [];
  for (const t of sheet.turns) {
    if (t.didWell?.why?.trim()) parts.push(`T${t.ordinal} did well: ${t.didWell.why.trim()}`);
    if (t.shortfall?.what?.trim()) {
      const should = t.shortfall.shouldHave?.trim() ? ` Should have: ${t.shortfall.shouldHave.trim()}` : "";
      parts.push(`T${t.ordinal} fell short: ${t.shortfall.what.trim()}.${should}`);
    }
  }
  return parts.length ? parts.join(" ") : null;
}
