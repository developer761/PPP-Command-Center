import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import type { ArchivedEmail } from "@/lib/commercial/email-archive/db";

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
  const { data: company } = await sb
    .from("commercial_operating_company")
    .select("email, reply_to_email")
    .limit(1)
    .maybeSingle();
  const c = (company ?? {}) as { email?: string | null; reply_to_email?: string | null };
  const ourDomains = [...new Set([c.email, c.reply_to_email].map((e) => domainOf(e ?? "")).filter(Boolean))];

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
