import Link from "next/link";
import { BUCKETS, loadInbox, bucketCounts, type InboxBucket } from "@/lib/messaging/db";
import { formatUs, type E164 } from "@/lib/messaging/phone";

export const dynamic = "force-dynamic";

const isBucket = (v: unknown): v is InboxBucket => BUCKETS.some((b) => b.key === v);

/** "2m", "4h", "3d" — a phone row has no room for "4 days ago". */
function ago(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

export default async function MessagingInbox({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string; ws?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const bucket: InboxBucket = isBucket(sp.bucket) ? sp.bucket : "needs_human";
  const workspaceId = sp.ws || undefined;
  const q = sp.q || "";

  const [{ rows, error }, counts] = await Promise.all([
    loadInbox(bucket, workspaceId, q),
    bucketCounts(workspaceId),
  ]);

  const href = (b: InboxBucket) =>
    `/messaging?bucket=${b}${workspaceId ? `&ws=${workspaceId}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <>
      {/* Top bar: the same three controls Hatch puts here — segmented state
          toggle, search, filter — so the office does not have to relearn the
          screen. Sticky, because on a phone the list is the whole session. */}
      <div className="sticky top-14 lg:top-0 z-20 bg-ppp-charcoal-50/95 backdrop-blur border-b border-ppp-charcoal-100">
        <div className="max-w-4xl mx-auto px-4 py-3 space-y-3">
          <form method="GET" className="flex gap-2">
            {workspaceId && <input type="hidden" name="ws" value={workspaceId} />}
            <input type="hidden" name="bucket" value={bucket} />
            <div className="relative flex-1 min-w-0">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden
                className="absolute left-3 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 pointer-events-none">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              {/* text-base so iOS does not zoom the page open on focus. */}
              <input
                name="q"
                defaultValue={q}
                placeholder="Search name or number"
                aria-label="Search conversations"
                className="w-full rounded-xl border border-ppp-charcoal-200 bg-white pl-9 pr-3 min-h-[44px] text-base sm:text-[13px] text-ppp-charcoal placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
              />
            </div>
            <button type="submit" className="shrink-0 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation">
              Search
            </button>
          </form>

          <nav aria-label="Filter conversations" className="-mx-4 px-4 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {BUCKETS.map((b) => {
              const on = b.key === bucket;
              return (
                <Link key={b.key} href={href(b.key)} aria-current={on ? "page" : undefined}
                  className={[
                    "shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 min-h-[38px] text-[13px] font-medium touch-manipulation transition-colors",
                    on ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600 hover:border-ppp-charcoal-300",
                  ].join(" ")}>
                  <span className="whitespace-nowrap">{b.label}</span>
                  <span className={`tabular-nums ${on ? "text-white/70" : "text-ppp-charcoal-400"}`}>{counts[b.key]}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-4 py-4 pb-safe">
        {error && (
          <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 text-[13px] text-ppp-orange-700">
            Could not load conversations. {error}
          </div>
        )}

        {!error && rows.length === 0 && (
          <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-10 text-center">
            <p className="font-semibold text-ppp-charcoal">
              {q ? `Nothing matching "${q}"` : `Nothing in ${BUCKETS.find((b) => b.key === bucket)!.label.toLowerCase()}`}
            </p>
            <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
              {q ? "Try a partial number, or clear the search."
                 : "Conversations land here as leads come in. Sending stays off until the carrier is connected and the opt-out list is imported."}
            </p>
          </div>
        )}

        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/messaging/${r.id}`}
                className="flex items-center gap-3 rounded-xl border border-ppp-charcoal-100 bg-white px-3.5 py-3 min-h-[64px] hover:border-ppp-charcoal-200 active:bg-ppp-charcoal-50 transition-colors touch-manipulation">
                <span className="h-9 w-9 shrink-0 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-500 text-[12px] font-bold flex items-center justify-center">
                  {(r.customer_name || "#").trim()[0]?.toUpperCase()}
                </span>
                {/* min-w-0 is load-bearing — without it a long name refuses to
                    shrink and pushes the timestamp off the screen. */}
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold text-ppp-charcoal truncate min-w-0">
                      {r.customer_name || formatUs(r.customer_phone as E164)}
                    </span>
                    <span className="shrink-0 text-[11px] font-mono text-ppp-charcoal-400">{ago(r.last_message_at)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ppp-charcoal-500 min-w-0">
                    <span className="truncate min-w-0">{r.workspace_name}</span>
                    {r.outcome && (<><span className="shrink-0 text-ppp-charcoal-300">·</span><span className="shrink-0 capitalize">{r.outcome.replace(/_/g, " ")}</span></>)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
