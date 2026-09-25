import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getEmailHub } from "@/lib/commercial/email-archive/hub";

export const metadata = { title: "Email" };

export const dynamic = "force-dynamic";

/**
 * Email hub — everything sent and received, in one place.
 *
 * The archive has always existed per record: a BCC address per job and per GC
 * files whatever is sent to it, readable on that deal's Email tab. What there
 * was no way to ask was "what have we sent this GC lately" or "did anyone
 * reply", without already knowing which job to open.
 *
 * `?show=` filters to sent or received; `?q=` searches subject, address and
 * the job it is filed against.
 */
const TABS = [
  { key: "all", label: "Everything" },
  { key: "sent", label: "Sent" },
  { key: "received", label: "Received" },
];

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function EmailHubPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; q?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await assertCommercialAccess(user.id);

  const sp = await searchParams;
  const show = TABS.some((t) => t.key === sp.show) ? sp.show! : "all";
  const q = (sp.q ?? "").trim().toLowerCase();

  const { emails, ourDomains } = await getEmailHub();
  const filtered = emails
    .filter((e) => (show === "sent" ? e.outbound : show === "received" ? !e.outbound : true))
    .filter((e) =>
      !q
        ? true
        : [e.subject, e.from_email, e.from_name, e.contextName, ...e.to_emails]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q))
    );

  const href = (next: { show?: string; q?: string }) => {
    const p = new URLSearchParams();
    const s = next.show ?? show;
    const query = next.q ?? q;
    if (s !== "all") p.set("show", s);
    if (query) p.set("q", query);
    const str = p.toString();
    return str ? `/commercial/email?${str}` : "/commercial/email";
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Email</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1 max-w-2xl">
          Everything filed against a job or a GC, sent and received together. Anything BCC&rsquo;d to a job&rsquo;s archive
          address lands here and on the job.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={href({ show: t.key })}
            aria-current={t.key === show ? "true" : undefined}
            className={`px-3 rounded-lg border text-[12.5px] font-semibold min-h-[38px] inline-flex items-center transition-colors ${
              t.key === show
                ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
            }`}
          >
            {t.label}
          </Link>
        ))}
        <form className="ml-auto flex items-center gap-1.5" action="/commercial/email">
          {show !== "all" && <input type="hidden" name="show" value={show} />}
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search subject, address or job…"
            className="rounded-lg border border-ppp-charcoal-200 bg-surface px-3 text-[12.5px] min-h-[38px] w-[15rem] max-w-full"
          />
        </form>
      </div>

      {ourDomains.length === 0 && emails.length > 0 && (
        // Without a sending domain on file, "sent" cannot be told from
        // "received" — say so rather than splitting them wrongly.
        <p className="text-[12px] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          No sending address is set on the operating company, so nothing can be identified as sent by us — everything
          is listed under Received. Set it in Settings to split the two.
        </p>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">
            {emails.length === 0 ? "No email has been archived yet" : "Nothing matches"}
          </p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
            {emails.length === 0
              ? // SAY WHERE THE ADDRESS IS. This told you to BCC "a job's
                // archive address" and never said where to get one — and the
                // Copy button lives two clicks away, inside a tab you would
                // only open if you already knew. An instruction whose first
                // step is missing is why this page stays empty.
                "Open a job → Activity → Email Archive, and copy the address there. BCC it on anything you send the GC and it files itself here, on the job, and on the GC."
              : "Try a different search, or switch tab."}
          </p>
        </div>
      ) : (
        <ul className="bg-surface border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
          {filtered.map((e) => (
            <li key={e.id} className="px-3.5 py-3">
              <div className="flex items-start gap-2 flex-wrap">
                <span
                  className={`shrink-0 text-[10px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 ${
                    e.outbound ? "bg-cc-brand-50 text-cc-brand-800" : "bg-emerald-50 text-emerald-800"
                  }`}
                >
                  {e.outbound ? "Sent" : "Received"}
                </span>
                <span className="text-[13px] font-semibold text-ppp-charcoal min-w-0 flex-1" title={e.subject ?? undefined}>
                  {e.subject?.trim() || "(no subject)"}
                </span>
                <span className="shrink-0 text-[11.5px] text-ppp-charcoal-400 tabular-nums">{when(e.received_at)}</span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-ppp-charcoal-500 flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                <span className="truncate" title={e.from_email}>
                  {e.from_name?.trim() || e.from_email}
                </span>
                {e.to_emails.length > 0 && <span className="truncate">→ {e.to_emails.join(", ")}</span>}
                <Link href={e.contextHref} className="font-semibold text-cc-brand-700 hover:underline truncate">
                  {e.contextName}
                </Link>
                {e.attachments.length > 0 && (
                  <span className="shrink-0">
                    📎 {e.attachments.length}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[11px] text-ppp-charcoal-400">
        Showing {filtered.length} of {emails.length} archived {emails.length === 1 ? "email" : "emails"}.
      </p>
    </div>
  );
}
