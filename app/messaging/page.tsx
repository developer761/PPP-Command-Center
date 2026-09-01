import Link from "next/link";
import { BUCKETS, loadInbox, bucketCounts, activeWorkspaces, type InboxBucket } from "@/lib/messaging/db";
import { formatUs } from "@/lib/messaging/phone";
import type { E164 } from "@/lib/messaging/phone";

export const dynamic = "force-dynamic";

const isBucket = (v: unknown): v is InboxBucket =>
  BUCKETS.some((b) => b.key === v);

/** "2m", "4h", "3d" — a phone has no room for "4 days ago" on every row. */
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
  searchParams: Promise<{ bucket?: string; ws?: string }>;
}) {
  const sp = await searchParams;
  // "Needs human" is the default view, not "All". The office opens this to
  // find what is waiting on a person, and an escalation nobody sees is an
  // escalation that failed.
  const bucket: InboxBucket = isBucket(sp.bucket) ? sp.bucket : "needs_human";
  const workspaceId = sp.ws || undefined;

  const [{ rows, error }, counts, workspaces] = await Promise.all([
    loadInbox(bucket, workspaceId),
    bucketCounts(workspaceId),
    activeWorkspaces(),
  ]);

  const href = (b: InboxBucket) =>
    `/messaging?bucket=${b}${workspaceId ? `&ws=${workspaceId}` : ""}`;

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe">
      {/* Workspace filter. A native select because 15 active workspaces is too
          many for chips, and a phone's own picker beats anything we build.
          text-base stops iOS zooming the page when it opens. */}
      <form method="GET" className="mb-3">
        <input type="hidden" name="bucket" value={bucket} />
        <label htmlFor="ws" className="sr-only">Workspace</label>
        <select
          id="ws"
          name="ws"
          defaultValue={workspaceId ?? ""}
          className="w-full sm:w-auto rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2 text-base sm:text-[13px] text-ppp-charcoal min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/40"
        >
          <option value="">All workspaces</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <noscript><button type="submit" className="ml-2 text-[13px] underline">Apply</button></noscript>
      </form>

      {/* Bucket chips. Horizontally scrollable and edge-to-edge on a phone —
          four chips with counts do not fit across 430px, and wrapping them
          into two rows costs more vertical space than the list can spare. */}
      <nav
        aria-label="Filter conversations"
        className="-mx-4 px-4 mb-4 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {BUCKETS.map((b) => {
          const on = b.key === bucket;
          return (
            <Link
              key={b.key}
              href={href(b.key)}
              aria-current={on ? "page" : undefined}
              className={[
                "shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 min-h-[40px] text-[13px] font-medium touch-manipulation transition-colors",
                on
                  ? "bg-ppp-charcoal text-white"
                  : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600 hover:border-ppp-charcoal-300",
              ].join(" ")}
            >
              <span className="whitespace-nowrap">{b.label}</span>
              <span className={on ? "text-white/70" : "text-ppp-charcoal-400"}>{counts[b.key]}</span>
            </Link>
          );
        })}
      </nav>

      {error && (
        <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 text-[13px] text-ppp-orange-700">
          Could not load conversations. {error}
        </div>
      )}

      {!error && rows.length === 0 && (
        // An empty state that says what WOULD be here and what has to happen
        // first, rather than a shrug. Right now the honest answer is that
        // nothing can arrive until the transport adapter and the Hatch opt-out
        // import land, and saying so beats "No conversations".
        <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-8 text-center">
          <p className="font-semibold text-ppp-charcoal">
            Nothing in {BUCKETS.find((b) => b.key === bucket)!.label.toLowerCase()}
          </p>
          <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
            Conversations appear here once leads start flowing. Sending is still
            switched off everywhere while the carrier is connected and the opt-out
            list is imported from Hatch.
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id}>
            {/* The whole row is the target — a 44px-tall row that only responds
                on the name is a row that misses. */}
            <Link
              href={`/messaging/${r.id}`}
              className="block rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 min-h-[64px] hover:border-ppp-charcoal-200 active:bg-ppp-charcoal-50 transition-colors touch-manipulation"
            >
              <div className="flex items-baseline justify-between gap-3">
                {/* min-w-0 is load-bearing: without it the flex child refuses to
                    shrink and a long name pushes the timestamp off-screen. */}
                <span className="font-semibold text-ppp-charcoal truncate min-w-0">
                  {r.customer_name || formatUs(r.customer_phone as E164)}
                </span>
                <span className="shrink-0 text-[11px] font-mono text-ppp-charcoal-400">
                  {ago(r.last_message_at)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[12px] text-ppp-charcoal-500 min-w-0">
                <span className="truncate min-w-0">{r.workspace_name}</span>
                {r.owning_agent && (
                  <>
                    <span className="shrink-0 text-ppp-charcoal-300">·</span>
                    <span className="shrink-0">{r.owning_agent}</span>
                  </>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
