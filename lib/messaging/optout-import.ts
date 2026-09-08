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

/** What actually gets written, per usable row. */
export function toOptOutRecords(preview: OptOutPreview): {
  phone_e164: string | null;
  email: string | null;
  channel: "sms" | "email";
  source: "hatch_import";
  opted_out_at: string | null;
}[] {
  return preview.rows
    .filter((r) => !r.problem)
    .map((r) => ({
      phone_e164: r.phone,
      email: r.email,
      // A row with a phone suppresses SMS; an email-only row suppresses email.
      // Both is not assumed — suppressing a channel somebody never opted out
      // of is its own kind of wrong, and the gate treats any matching row as
      // suppression for that channel anyway.
      channel: r.phone ? "sms" : "email",
      source: "hatch_import" as const,
      opted_out_at: r.optedOutAt,
    }));
}
