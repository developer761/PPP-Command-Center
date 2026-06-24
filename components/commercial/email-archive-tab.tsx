import {
  listArchivedEmails,
  type ArchivedEmail,
  type ArchivedEmailAttachment,
} from "@/lib/commercial/email-archive/db";
import {
  buildArchiveAddress,
  isArchiveConfigured,
  type ArchiveKind,
} from "@/lib/commercial/email-archive/address";
import CopyArchiveAddressButton from "./copy-archive-address-button";

/**
 * Email Archive tab — rendered on both /commercial/opportunities/[id]
 * and /commercial/accounts/[id]. Single component covers both surfaces
 * because the data shape + layout are identical.
 *
 * Mobile-first:
 *   - Stack-by-default, side-by-side on sm+ for the address bar
 *   - Email cards full-width with a 56px+ row chrome
 *   - Attachment download buttons 44px min
 *   - Body truncates after 12 lines unless expanded (no JS — uses CSS
 *     `details`/`summary` so it works without hydration)
 *
 * Plain-text default render. "Show HTML" toggle uses the SANITIZED
 * body_html (script/iframe/on-* already stripped server-side).
 */

export default async function EmailArchiveTab({
  kind,
  sourceId,
}: {
  kind: ArchiveKind;
  sourceId: string;
}) {
  const configured = isArchiveConfigured();
  const address = configured ? buildArchiveAddress(kind, sourceId) : null;
  const emails = await listArchivedEmails(kind, sourceId);

  return (
    <div className="space-y-4 sm:space-y-5">
      <ArchiveAddressBar configured={configured} address={address} kind={kind} />

      {emails.length === 0 ? (
        <EmptyState configured={configured} kind={kind} />
      ) : (
        <ul className="space-y-3">
          {emails.map((e) => (
            <li key={e.id}>
              <EmailCard email={e} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArchiveAddressBar({
  configured,
  address,
  kind,
}: {
  configured: boolean;
  address: string | null;
  kind: ArchiveKind;
}) {
  if (!configured || !address) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-semibold text-amber-900 mb-1">
          Archive address not configured
        </p>
        <p className="text-xs text-amber-800 leading-relaxed">
          The BCC archive feature needs <code className="font-mono">COMMERCIAL_ARCHIVE_HMAC_SECRET</code> set
          on the deployment + an inbound DNS record on the configured archive
          domain. Ping Karan to flip the switch.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-white p-4 sm:p-5 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ppp-charcoal mb-1">
            Auto-archive your customer emails here
          </h3>
          <p className="text-xs text-ppp-charcoal-500 leading-relaxed">
            This {kind === "opp" ? "deal" : "account"} has its own private email address (below).
            Copy it, then BCC it whenever you email the customer about this {kind === "opp" ? "deal" : "account"} —
            your message and any replies will land in this tab automatically.
            Save it to your phone or Gmail as &ldquo;{kind === "opp" ? "Opp Archive" : "Account Archive"}&rdquo; so it&apos;s one tap to add.
          </p>
        </div>
        <div className="shrink-0">
          <CopyArchiveAddressButton address={address} />
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  configured,
  kind,
}: {
  configured: boolean;
  kind: ArchiveKind;
}) {
  return (
    <div className="rounded-xl border border-dashed border-ppp-charcoal-200 bg-ppp-charcoal-50 p-6 sm:p-8 text-center">
      <p className="text-sm font-semibold text-ppp-charcoal mb-2">
        No archived emails yet
      </p>
      <p className="text-xs text-ppp-charcoal-500 max-w-md mx-auto leading-relaxed">
        {configured
          ? `Copy the address above and paste it into your BCC field. The next email you send (and every reply) lands here.`
          : `Once Karan flips on the archive feature, BCC'd ${kind === "opp" ? "opportunity" : "account"} emails will appear here.`}
      </p>
    </div>
  );
}

function EmailCard({ email }: { email: ArchivedEmail }) {
  const senderLabel = email.from_name
    ? `${email.from_name} <${email.from_email}>`
    : email.from_email;
  const recipients = [...email.to_emails, ...email.cc_emails];
  const recipientsLabel =
    recipients.length === 0
      ? "(no other recipients)"
      : recipients.slice(0, 3).join(", ") +
        (recipients.length > 3 ? ` +${recipients.length - 3} more` : "");
  const dateLabel = formatDate(email.received_at);

  return (
    <article className="rounded-xl border border-ppp-charcoal-100 bg-white shadow-sm overflow-hidden">
      <header className="px-4 sm:px-5 pt-4 pb-2">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1.5">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm sm:text-base font-semibold text-ppp-charcoal leading-snug break-words">
              {email.subject || "(no subject)"}
            </h4>
            <p className="mt-1 text-xs text-ppp-charcoal-600 break-words">
              <span className="font-medium">From:</span> {senderLabel}
            </p>
            <p className="mt-0.5 text-xs text-ppp-charcoal-500 break-words">
              <span className="font-medium">To:</span> {recipientsLabel}
            </p>
          </div>
          <div className="flex items-center gap-2 sm:flex-col sm:items-end sm:gap-1 shrink-0">
            <ClassificationBadge value={email.classification} />
            <time
              className="text-xs text-ppp-charcoal-400 whitespace-nowrap"
              dateTime={email.received_at}
            >
              {dateLabel}
            </time>
          </div>
        </div>
      </header>

      <details className="group border-t border-ppp-charcoal-100">
        <summary className="px-4 sm:px-5 py-3 cursor-pointer touch-manipulation list-none flex items-center justify-between hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors min-h-[44px]">
          <span className="text-xs sm:text-sm font-medium text-ppp-blue">
            Show message
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="text-ppp-charcoal-400 transition-transform group-open:rotate-180"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>
        <div className="px-4 sm:px-5 pb-4 pt-1 space-y-3">
          {email.body_text ? (
            <pre className="text-xs sm:text-sm text-ppp-charcoal whitespace-pre-wrap font-sans leading-relaxed break-words">
              {email.body_text}
            </pre>
          ) : (
            <p className="text-xs text-ppp-charcoal-500 italic">
              (no plain-text body — sender used HTML only)
            </p>
          )}
          {email.body_truncated && (
            <p className="text-[11px] text-ppp-charcoal-500 italic">
              Body truncated at 200 KB. Full original preserved in storage —
              download via the raw payload if needed.
            </p>
          )}
          {email.body_html && (
            <details className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50">
              <summary className="px-3 py-2.5 cursor-pointer touch-manipulation text-xs font-medium text-ppp-charcoal-700 hover:bg-ppp-charcoal-100 min-h-[44px] flex items-center">
                Show HTML view (sanitized)
              </summary>
              {/* overflow-x-auto + image/table max-width guards keep
                  600px-wide marketing emails from blowing horizontal
                  scroll on a 375px iPhone. arbitrary-class variants force
                  inline-styled <img>/<table> elements to respect the
                  container width. */}
              <div
                className="px-3 pb-3 pt-1 text-sm bg-white border-t border-ppp-charcoal-100 overflow-x-auto max-w-full [&_img]:max-w-full [&_img]:h-auto [&_table]:max-w-full"
                // Server-side sanitization strips script/iframe/style/on-*
                // handlers + javascript:/data:/vbscript: URLs (with HTML-
                // entity decoding so `java&#x09;script:` is caught too) +
                // ALL inline `style="…"` attributes before storing. See
                // lib/commercial/email-archive/sanitize.ts.
                dangerouslySetInnerHTML={{ __html: email.body_html }}
              />
            </details>
          )}
          {email.attachments.length > 0 && (
            <AttachmentList emailId={email.id} attachments={email.attachments} />
          )}
        </div>
      </details>
    </article>
  );
}

function AttachmentList({
  emailId,
  attachments,
}: {
  emailId: string;
  attachments: ArchivedEmailAttachment[];
}) {
  return (
    <div className="space-y-1.5">
      <h5 className="text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500">
        Attachments ({attachments.length})
      </h5>
      <ul className="space-y-1.5">
        {attachments.map((a, idx) => (
          <li key={`${emailId}-${idx}`}>
            <a
              href={`/api/commercial/email-archive/${emailId}/attachments/${idx}`}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-ppp-charcoal-100 bg-white text-xs sm:text-sm text-ppp-blue hover:bg-ppp-blue-50 hover:border-ppp-blue-200 active:bg-ppp-blue-100 transition-colors touch-manipulation min-h-[44px] max-w-full"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="shrink-0"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10 12 15 17 10 M12 15V3" />
              </svg>
              <span className="truncate min-w-0">
                {a.filename}{" "}
                <span className="text-ppp-charcoal-400 font-normal">
                  ({formatBytes(a.size_bytes)})
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClassificationBadge({
  value,
}: {
  value: "internal" | "external" | "system";
}) {
  const styles: Record<typeof value, string> = {
    internal: "bg-ppp-blue-50 text-ppp-blue border-ppp-blue-200",
    external: "bg-amber-50 text-amber-800 border-amber-200",
    system: "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200",
  };
  const labels: Record<typeof value, string> = {
    internal: "PPP",
    external: "External",
    system: "Auto-reply",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${styles[value]}`}
    >
      {labels[value]}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const now = Date.now();
  const ageMs = now - d.getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  if (ageMs < oneDay) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (ageMs < 7 * oneDay) {
    return d.toLocaleDateString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
