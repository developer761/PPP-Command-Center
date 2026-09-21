/**
 * Loading Hatch's suppression list.
 *
 * This is the last thing standing between the system and a TCPA problem, and
 * it is the one item on the launch list where being late costs money rather
 * than time. The suppression table is empty. Every number in Hatch that told
 * PPP to stop is, as far as this system knows, fair game.
 *
 * Kate's own analysis of the path this replaces:
 *
 *     213  opt-out notifications Salesforce could not match
 *      98  had no Salesforce record at all
 *      92  arrived over EMAIL, not SMS
 *      55  matched a record still not marked opted out
 *
 * Which is why this imports from HATCH and not from Salesforce. Salesforce is
 * downstream of a matching step that demonstrably drops a quarter of them;
 * Hatch is where the person actually said stop.
 *
 * Pure. Parses, normalises, dedupes and reports — the caller writes.
 */
import { parseCsv, matchHeader } from "./csv";
import { toE164 } from "./phone";

const PHONE_HEADERS = ["phone", "phone_number", "phonenumber", "mobile", "to", "number", "handset", "contact"];
const EMAIL_HEADERS = ["email", "email_address", "emailaddress", "e-mail"];
const DATE_HEADERS  = ["opted_out_at", "opt_out_date", "date", "created_at", "timestamp", "unsubscribed_at"];

/**
 * Comfortably above Kate's 213, comfortably below a serverless timeout.
 *
 * Lives here rather than beside the importer because that file is
 * "use server", and a server-action module may export ONLY async functions —
 * a plain const there makes Next drop every export in the module, which the
 * type checker cannot see and only the production build catches.
 */
export const MAX_IMPORT_ROWS = 2000;

export type OptOutRow = {
  phone: string | null;
  email: string | null;
  optedOutAt: string | null;
  /** Why this row cannot be imported, if it cannot. */
  problem: string | null;
};

export type OptOutPreview = {
  rows: OptOutRow[];
  usable: number;
  /** Rows carrying an email and no phone. Kate's export had 92 of them, and an
   *  importer that only reads phone numbers would silently drop every one. */
  emailOnly: number;
  duplicates: number;
  unusable: number;
  detectedHeaders: { phone: string | null; email: string | null; date: string | null };
};

export function buildOptOutPreview(text: string): OptOutPreview {
  const { headers, rows } = parseCsv(text);
  const phoneCol = matchHeader(headers, PHONE_HEADERS);
  const emailCol = matchHeader(headers, EMAIL_HEADERS);
  const dateCol = matchHeader(headers, DATE_HEADERS);

  const seen = new Set<string>();
  let duplicates = 0;

  const out: OptOutRow[] = rows.map((r) => {
    const rawPhone = phoneCol ? (r[phoneCol] ?? "").trim() : "";
    const rawEmail = emailCol ? (r[emailCol] ?? "").trim().toLowerCase() : "";
    const rawDate = dateCol ? (r[dateCol] ?? "").trim() : "";

    const phone = rawPhone ? toE164(rawPhone) : null;
    // A row that HAS a phone column filled in but which will not normalise is
    // a problem to show, not a row to quietly treat as email-only. Kate needs
    // to see the ones we could not read.
    if (rawPhone && !phone) {
      return { phone: null, email: rawEmail || null, optedOutAt: null, problem: `"${rawPhone}" is not a usable phone number` };
    }

    const email = rawEmail && rawEmail.includes("@") ? rawEmail : null;
    if (rawEmail && !email) {
      return { phone, email: null, optedOutAt: null, problem: `"${rawEmail}" is not a usable email address` };
    }

    if (!phone && !email) {
      return { phone: null, email: null, optedOutAt: null, problem: "no phone and no email" };
    }

    // Dedupe on whichever identifiers the row carries. The same person can
    // legitimately appear twice — once per channel — so the key is per
    // identifier rather than per row.
    const key = `${phone ?? ""}|${email ?? ""}`;
    if (seen.has(key)) { duplicates++; return { phone, email, optedOutAt: null, problem: "already in this file" }; }
    seen.add(key);

    // An unreadable date is not a reason to skip an opt-out. Losing when they
    // said stop is survivable; losing that they said it is not.
    let optedOutAt: string | null = null;
    if (rawDate) {
      const d = new Date(rawDate);
      if (!Number.isNaN(d.getTime())) optedOutAt = d.toISOString();
    }

    return { phone, email, optedOutAt, problem: null };
  });

  const good = out.filter((r) => !r.problem);
  return {
    rows: out,
    usable: good.length,
    emailOnly: good.filter((r) => !r.phone && r.email).length,
    duplicates,
    unusable: out.filter((r) => r.problem && r.problem !== "already in this file").length,
    detectedHeaders: { phone: phoneCol, email: emailCol, date: dateCol },
  };
}

/**
 * What actually gets written: ONE ROW PER IDENTIFIER.
 *
 * Not a stylistic choice. Migration 186 puts two PARTIAL unique indexes on
 * this table — one on the active phone, one on the active lowercased email —
 * and a single row carrying BOTH identifiers can only ever violate one of
 * them. optout-import-write treats any 23505 as "already suppressed on that
 * channel".
 *
 * So Bob appears email-only in one export and again, later, WITH his phone.
 * The second insert collides on the EMAIL index, is counted as already
 * present, and Bob's HANDSET is never suppressed — while the importer reports
 * success. He is textable, out of the one table whose entire purpose is that
 * he is not. Kate's export is exactly this shape, and the import screen
 * actively tells her to split large files because "overlapping is fine".
 *
 * Suppression semantics are unchanged. The gate reads the phone column for SMS
 * and the email column for email, so a row per identifier suppresses precisely
 * what the combined row did; what changes is that each channel now hits its
 * own index and can be inserted, or recognised as a duplicate, on its own.
 */
export function toOptOutRecords(preview: OptOutPreview): {
  phone_e164: string | null;
  email: string | null;
  channel: "sms" | "email";
  source: "hatch_import";
  opted_out_at: string | null;
}[] {
  const out: {
    phone_e164: string | null; email: string | null;
    channel: "sms" | "email"; source: "hatch_import"; opted_out_at: string | null;
  }[] = [];
  // Per identifier, not per row: the same address on two lines must not be
  // written twice, or the second write is a 23505 that masks the first.
  const written = new Set<string>();

  for (const r of preview.rows) {
    if (r.problem) continue;
    if (r.phone && !written.has(`p:${r.phone}`)) {
      written.add(`p:${r.phone}`);
      out.push({ phone_e164: r.phone, email: null, channel: "sms", source: "hatch_import", opted_out_at: r.optedOutAt });
    }
    if (r.email && !written.has(`e:${r.email}`)) {
      written.add(`e:${r.email}`);
      out.push({ phone_e164: null, email: r.email, channel: "email", source: "hatch_import", opted_out_at: r.optedOutAt });
    }
  }
  return out;
}
