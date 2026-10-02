/**
 * Assigning ported numbers to workspaces from a spreadsheet.
 *
 * ── WHY THIS IS WORTH BUILDING ──────────────────────────────────────────
 *
 * Every workspace sends from its own local number, and the port moves them a
 * region at a time. Today each one is a hand-written UPDATE against
 * production — that is how +18888156464 reached ZZ TEST — so thirty-odd
 * numbers means thirty-odd statements typed against the live database, in an
 * order nobody is tracking, while numbers are activating hours apart.
 *
 * ── WHAT GOES WRONG WHEN IT IS WRONG ────────────────────────────────────
 *
 * Not a failed import. A SILENT MISROUTE.
 *
 * A workspace holding the wrong number sends from an area code its customers
 * do not recognise, and the replies land in a different region's queue — so
 * Nassau answers Queens's leads and neither looks broken. Two workspaces
 * holding the SAME number is worse: inbound cannot be attributed at all, and
 * verify-port-readiness asserts "no two workspaces share a number" precisely
 * because that is unrecoverable once conversations exist against it.
 *
 * So the checks here are not formatting checks. They are the two properties
 * that script asserts, enforced before the write rather than discovered after
 * it.
 *
 * ── WHAT THE FILE LOOKS LIKE ────────────────────────────────────────────
 *
 *   workspace, number
 *   NY LI Nassau Leads, (516) 344-8418
 *
 * Two columns. The number is read with toE164, the same parser the inbound
 * path uses, so anything a person would paste — +1 516 344 8418, 516-344-8418,
 * 5163448418 — lands the same way the carrier would send it. A number that
 * parser refuses is bad data, not a formatting preference.
 *
 * Pure. Parses, matches, checks and reports — the caller writes.
 */
import { parseCsv, matchHeader } from "./csv";
import { toE164 } from "./phone";

const WORKSPACE_HEADERS = ["workspace", "sub account", "sub_account", "account", "region", "market", "name"];
const NUMBER_HEADERS = ["number", "phone", "phone number", "phone_e164", "did", "from", "sending number"];

/**
 * Comfortably above 32 workspaces, comfortably below a serverless timeout.
 * Exported from HERE rather than the write module, which is "use server" and
 * may export only async functions — a plain const there silently drops every
 * export in the module, and tsc cannot see it.
 */
export const MAX_NUMBER_IMPORT_ROWS = 200;

export type NumberImportRow = {
  /** The workspace NAME as written in the file. */
  workspaceName: string;
  /** Resolved against the real workspaces, or null when nothing matched. */
  workspaceId: string | null;
  /** The number as written in the file, for showing a problem back. */
  raw: string;
  /** E.164, or null when the number could not be read. */
  phoneE164: string | null;
  /** What this workspace holds today, when it already holds something. */
  currentPhone: string | null;
  /** Which line of the file, so a problem can be pointed at. */
  line: number;
  /** Why this row cannot be imported, if it cannot. */
  problem: string | null;
};

export type NumberImportPreview = {
  rows: NumberImportRow[];
  usable: number;
  unusable: number;
  /** Rows that would CHANGE a number the workspace already holds. */
  replacing: number;
  /** Rows whose workspace already holds exactly this number — no-ops. */
  unchanged: number;
  detectedHeaders: { workspace: string | null; number: string | null };
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export type KnownWorkspace = {
  id: string;
  name: string;
  /** What it holds now, if anything. */
  phoneE164: string | null;
};

/**
 * Read the file and say exactly what would happen, without doing any of it.
 *
 * `workspaces` is the real table. Resolution is by NAME because that is what
 * a person types in a spreadsheet; ids are not something anybody will copy
 * correctly thirty times.
 */
export function buildNumberImportPreview(
  text: string,
  workspaces: readonly KnownWorkspace[],
): NumberImportPreview {
  const parsed = parseCsv(text);
  const workspaceHeader = matchHeader(parsed.headers, WORKSPACE_HEADERS);
  const numberHeader = matchHeader(parsed.headers, NUMBER_HEADERS);

  const byName = new Map<string, KnownWorkspace>();
  for (const w of workspaces) byName.set(norm(w.name), w);

  /** Every number already on the table, so a collision names its holder. */
  const holderOf = new Map<string, KnownWorkspace>();
  for (const w of workspaces) if (w.phoneE164) holderOf.set(w.phoneE164, w);

  const rows: NumberImportRow[] = [];
  /** Numbers claimed EARLIER IN THIS FILE, so two rows cannot claim one. */
  const claimedInFile = new Map<string, number>();
  /** Workspaces named earlier in this file, so one cannot be set twice. */
  const namedInFile = new Map<string, number>();

  for (const [i, record] of parsed.rows.entries()) {
    const line = i + 2; // 1-based, past the header
    const workspaceName = (workspaceHeader ? record[workspaceHeader] ?? "" : "").trim();
    const raw = (numberHeader ? record[numberHeader] ?? "" : "").trim();

    if (!workspaceName && !raw) continue; // a blank line is not a problem

    const ws = byName.get(norm(workspaceName)) ?? null;
    const phoneE164 = toE164(raw);

    let problem: string | null = null;
    if (!workspaceName) problem = "no workspace named";
    else if (!ws) problem = `no workspace called "${workspaceName}"`;
    else if (!raw) problem = "no number given";
    else if (!phoneE164) problem = `"${raw}" is not a usable phone number`;
    /**
     * US ONLY, because every sender on this account is a US long code or
     * toll-free and a foreign number here would be a typo that toE164
     * happens to accept — it deliberately does not validate foreign plans.
     */
    else if (!phoneE164.startsWith("+1")) problem = `${phoneE164} is not a US number`;
    else if (claimedInFile.has(phoneE164)) {
      problem = `${phoneE164} is already claimed on line ${claimedInFile.get(phoneE164)} of this file`;
    } else if (namedInFile.has(norm(workspaceName))) {
      problem = `${workspaceName} is already set on line ${namedInFile.get(norm(workspaceName))} of this file`;
    } else {
      /**
       * THE COLLISION THAT MATTERS. Another workspace already holds this
       * number, and the file does not move it off them — so applying this
       * would leave two workspaces on one number, which is the state
       * verify-port-readiness exists to refuse.
       *
       * A row that REASSIGNS a number is only safe when the current holder is
       * also being changed in the same file, which the second condition
       * allows: their row sets them to something else.
       */
      const holder = holderOf.get(phoneE164);
      if (holder && holder.id !== ws.id) {
        const holderMovedHere = parsed.rows.some((r, j) => {
          if (j === i) return false;
          const n = norm((workspaceHeader ? r[workspaceHeader] ?? "" : "").trim());
          if (n !== norm(holder.name)) return false;
          const other = toE164((numberHeader ? r[numberHeader] ?? "" : "").trim());
          return !!other && other !== phoneE164;
        });
        if (!holderMovedHere) {
          problem = `${phoneE164} already belongs to ${holder.name}, and this file does not move them off it`;
        }
      }
    }

    if (!problem && ws && phoneE164) {
      claimedInFile.set(phoneE164, line);
      namedInFile.set(norm(workspaceName), line);
    }

    rows.push({
      workspaceName,
      workspaceId: ws?.id ?? null,
      raw,
      phoneE164,
      currentPhone: ws?.phoneE164 ?? null,
      line,
      problem,
    });
  }

  const usableRows = rows.filter((r) => !r.problem);
  return {
    rows,
    usable: usableRows.length,
    unusable: rows.length - usableRows.length,
    replacing: usableRows.filter((r) => r.currentPhone && r.currentPhone !== r.phoneE164).length,
    unchanged: usableRows.filter((r) => r.currentPhone === r.phoneE164).length,
    detectedHeaders: { workspace: workspaceHeader, number: numberHeader },
  };
}

/** The writes a preview implies, skipping the no-ops. */
export function toNumberAssignments(
  preview: NumberImportPreview,
): { workspaceId: string; phoneE164: string }[] {
  return preview.rows
    .filter((r) => !r.problem && r.workspaceId && r.phoneE164 && r.currentPhone !== r.phoneE164)
    .map((r) => ({ workspaceId: r.workspaceId as string, phoneE164: r.phoneE164 as string }));
}
