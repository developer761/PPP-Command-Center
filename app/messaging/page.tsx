import Link from "next/link";
import {
  BOARD_COLUMNS, loadBoard, activeWorkspaces,
  type BoardColumnKey, type BoardCard,
} from "@/lib/messaging/db";
import { formatUs, type E164 } from "@/lib/messaging/phone";

export const dynamic = "force-dynamic";

const isCol = (v: unknown): v is BoardColumnKey => BOARD_COLUMNS.some((c) => c.key === v);

function ago(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/**
 * Conversations — a board, matching Hatch.
 *
 * Desktop shows the columns side by side, as Hatch does. A phone does not: four
 * 320px columns across 430px means scrolling sideways to discover that a column
 * exists, and a column you have to find is a column nobody works. Below lg the
 * columns become a selector and one column fills the screen — the same
 * information, in the shape the device can actually show.
 */
export default async function ConversationsBoard({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; col?: string }>;
}) {
  const sp = await searchParams;
  const workspaceId = sp.ws || undefined;
  const active: BoardColumnKey = isCol(sp.col) ? sp.col : "inbox";

  const [columns, workspaces] = await Promise.all([loadBoard(workspaceId), activeWorkspaces()]);
  const ws = workspaces.find((w) => w.id === workspaceId);
  const href = (c: BoardColumnKey) => `/messaging?col=${c}${workspaceId ? `&ws=${workspaceId}` : ""}`;

  return (
    <>
      <div className="sticky top-14 lg:top-0 z-20 bg-ppp-charcoal-50/95 backdrop-blur border-b border-ppp-charcoal-100">
        <div className="px-4 py-3">
          <h1 className="font-bold text-ppp-charcoal truncate">{ws?.name ?? "All workspaces"}</h1>
          {ws?.phone_e164 && (
            <p className="text-[12px] text-ppp-charcoal-500 font-mono">
              {formatUs(ws.phone_e164 as E164)}
            </p>
          )}
          {/* Column selector — the whole board on a phone, and a quick jump on
              desktop where the columns are already visible. */}
          <nav aria-label="Board columns" className="lg:hidden -mx-4 px-4 mt-3 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {BOARD_COLUMNS.map((c) => {
              const on = c.key === active;
              return (
                <Link key={c.key} href={href(c.key)} aria-current={on ? "page" : undefined}
                  className={[
                    "shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 min-h-[38px] text-[13px] font-medium touch-manipulation",
                    on ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600",
                  ].join(" ")}>
                  <span className="whitespace-nowrap">{c.label}</span>
                  <span className={`tabular-nums ${on ? "text-white/70" : "text-ppp-charcoal-400"}`}>
                    {columns[c.key].length}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="px-4 py-4 pb-safe">
        {/* Mobile: one column. */}
        <div className="lg:hidden">
          <Column col={BOARD_COLUMNS.find((c) => c.key === active)!} cards={columns[active]} />
        </div>
        {/* Desktop: all four, as Hatch shows them. */}
        <div className="hidden lg:grid lg:grid-cols-4 lg:gap-3 lg:items-start">
          {BOARD_COLUMNS.map((c) => (
            <Column key={c.key} col={c} cards={columns[c.key]} />
          ))}
        </div>
      </div>
    </>
  );
}

function Column({
  col, cards,
}: {
  col: (typeof BOARD_COLUMNS)[number];
  cards: BoardCard[];
}) {
  return (
    <section className="min-w-0">
      <div className="hidden lg:flex items-center gap-2 px-1 pb-2">
        <h2 className="text-[13px] font-semibold text-ppp-charcoal truncate">{col.label}</h2>
        <span className="text-[11px] font-mono text-ppp-charcoal-400 tabular-nums">{cards.length}</span>
      </div>

      {!col.derivable && (
        // Better an honest empty column than one that looks populated and is
        // quietly wrong about which conversations belong in it.
        <div className="rounded-xl border border-dashed border-ppp-charcoal-200 bg-white/60 px-4 py-4 text-center">
          <p className="text-[12.5px] font-medium text-ppp-charcoal-600">Not wired up yet</p>
          <p className="mt-1 text-[12px] text-ppp-charcoal-500 leading-relaxed">
            This one is about the estimator, not the customer. PPP has not said
            what puts a conversation in or out of it, so it is left empty rather
            than filled with a guess.
          </p>
        </div>
      )}

      {col.derivable && cards.length === 0 && (
        <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-6 text-center">
          <p className="text-[12.5px] text-ppp-charcoal-500">Nothing here</p>
        </div>
      )}

      <ul className="space-y-2">
        {cards.map((c) => (
          <li key={c.id}>
            <Link href={`/messaging/${c.id}`}
              className="block rounded-xl border border-ppp-charcoal-100 bg-white px-3.5 py-3 hover:border-ppp-charcoal-200 active:bg-ppp-charcoal-50 transition-colors touch-manipulation">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-ppp-charcoal truncate min-w-0">
                  {c.customer_name || formatUs(c.customer_phone as E164)}
                </span>
                <span className="shrink-0 text-[11px] font-mono text-ppp-charcoal-400">{ago(c.last_message_at)}</span>
              </div>
              {c.preview && (
                // Two lines. A phone card that grows with the message stops
                // being scannable, and the point of a card is the glance.
                <p className="mt-1.5 text-[12.5px] text-ppp-charcoal-600 leading-snug line-clamp-2">
                  {c.direction === "inbound" ? "" : "↩ "}{c.preview}
                </p>
              )}
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ppp-charcoal-500">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                </svg>
                <span className="truncate">{c.owning_agent ?? "Not assigned"}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
