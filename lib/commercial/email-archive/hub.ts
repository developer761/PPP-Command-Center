import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import type { ArchivedEmail } from "@/lib/commercial/email-archive/db";
import { commercialSenderDomains } from "@/lib/email/resend";

/**
 * Every archived email, across every job and GC, in one place.
 *
 * The archive already existed — a BCC address per opportunity and per account
 * files whatever is sent to it — but it could only ever be read one record at a
 * time, on that deal's Email tab. So "what have we sent this GC?" meant opening
 * each of their jobs in turn, and "did anyone reply?" had no answer at all
 * without knowing which job to look on.
 *
 * SENT vs RECEIVED is decided by who it is FROM: an email from a Tomco address
 * is one we sent, anything else is one that came in. That is the only signal
 * the archive carries — it stores what arrived at the BCC address, not a
 * send-log — so it is derived here once rather than guessed at per screen.
 */

export type HubEmail = ArchivedEmail & {
  /** The job or GC it was filed against. */
  contextName: string;
  contextHref: string;
  /** From one of our own addresses. */
  outbound: boolean;
};

export type EmailHub = {
  emails: HubEmail[];
  /** Domains that count as ours, for the caller to explain the split. */
  ourDomains: string[];
};

const domainOf = (email: string): string => (email.split("@")[1] ?? "").trim().toLowerCase();

export async function getEmailHub(limit = 400): Promise<EmailHub> {
  const sb = commercialDb();

  const emails = await paginateAll<ArchivedEmail>(() =>
    sb
      .from("commercial_archived_emails")
      .select(
        "id, source_kind, source_id, message_id, in_reply_to, from_email, from_name, to_emails, cc_emails, bcc_emails, subject, body_text, body_html, body_truncated, attachments, classification, received_at, created_at, deleted_at"
      )
      .is("deleted_at", null)
      .order("id", { ascending: true })
  );
  if (emails.length === 0) return { emails: [], ourDomains: [] };

  // Name what each one is filed against, in two queries rather than one per row.
  const oppIds = [...new Set(emails.filter((e) => e.source_kind === "opp").map((e) => e.source_id))];
  const accIds = [...new Set(emails.filter((e) => e.source_kind === "acc").map((e) => e.source_id))];

  const [opps, accounts] = await Promise.all([
    oppIds.length
      ? paginateAll<{
          id: string;
          account_id: string;
          title: string | null;
          client_name: string | null;
          title_override: string | null;
          title_override_mode: string | null;
          property_street: string | null;
        }>(() =>
          sb
            .from("commercial_opportunities")
            .select("id, account_id, title, client_name, title_override, title_override_mode, property_street")
            .in("id", oppIds)
            .order("id", { ascending: true })
        )
      : Promise.resolve([]),
    sb
      .from("commercial_accounts")
      .select("id, company_name")
      .then((r) => (r.data ?? []) as { id: string; company_name: string | null }[]),
  ]);
  const acctName = new Map(accounts.map((a) => [a.id, a.company_name ?? "—"]));
  const oppName = new Map(
    opps.map((o) => [o.id, derivedOppName({ ...o, title: o.title ?? "" }, acctName.get(o.account_id) ?? null)])
  );

  // OUR domains, learned from the operating company and from what the platform
  // sends as — rather than hard-coding "tomcopainting.com", which would be
  // wrong the moment the sending domain changes (which it is about to).
  //
  // WHAT COUNTS AS OURS.
  //
  // This asked the operating company for `email, reply_to_email`.
  // `reply_to_email` IS NOT A COLUMN on that table — the migration never ran —
  // so PostgREST rejected the whole select, `company` came back null, and
  // `ourDomains` was ALWAYS empty. Every archived email was therefore labelled
  // "Received", the Sent tab was permanently empty, and the banner told the
  // reader to set a sending address in Settings, which was impossible. A
  // silent query error that produced a plausible-looking wrong answer.
  //
  // The reliable source is what the platform actually sends as, which is now
  // explicit (invoices finance@, proposals estimating@, everything else the
  // Tomco default) and cannot drift the way an unfilled column did. The
  // operating-company address is still honoured when someone sets one, and a
  // failure to read it no longer takes the answer down with it.
  const { data: company, error: companyErr } = await sb
    .from("commercial_operating_company")
    .select("email")
    .limit(1)
    .maybeSingle();
  if (companyErr) {
    console.warn("[email-archive/hub] operating company lookup failed:", companyErr.message);
  }
  const c = (company ?? {}) as { email?: string | null };
  const ourDomains = [
    ...new Set(
      [domainOf(c.email ?? ""), ...commercialSenderDomains()].filter(Boolean)
    ),
  ];

  const hub: HubEmail[] = emails
    .map((e) => ({
      ...e,
      contextName:
        e.source_kind === "opp" ? oppName.get(e.source_id) ?? "Job" : acctName.get(e.source_id) ?? "GC",
      contextHref:
        e.source_kind === "opp"
          ? `/commercial/opportunities/${e.source_id}?tab=activity`
          : `/commercial/accounts/${e.source_id}`,
      outbound: ourDomains.length > 0 && ourDomains.includes(domainOf(e.from_email)),
    }))
    .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))
    .slice(0, limit);

  return { emails: hub, ourDomains };
}
