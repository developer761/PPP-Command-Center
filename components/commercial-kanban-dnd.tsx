"use client";

import { useState, useRef, useTransition, type DragEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/**
 * Tiny client wrapper that adds HTML5 drag-and-drop on top of the
 * server-rendered kanban. The server still does all the heavy
 * fetching + rendering; this component only:
 *   - Marks card-children as `draggable={true}`
 *   - Captures dragstart to store the opp_id
 *   - Captures dragover/drop on column-children to call the move API
 *   - Visual emerald drop-shadow on the column being hovered
 *
 * Touch devices fall back gracefully — the inline "Move to…" dropdown
 * inside each card still works (HTML5 DnD doesn't fire on touch by
 * design, which is correct).
 */

export function KanbanDnDProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [dragOppId, setDragOppId] = useState<string | null>(null);
  // Karan 2026-07-15 (round 5): track the drag source's account id so
  // the per-account mini-kanbans on /commercial/opportunities can
  // BLOCK cross-account drops. Dragging card-from-Account-A onto
  // Account-B's column would technically flip the opp's status (harm-
  // less server-side, opp.account_id doesn't change) but the card
  // would visually snap back to Account-A's section on refresh —
  // confusing. Block the drop before it fires.
  const [dragAccountId, setDragAccountId] = useState<string | null>(null);
  // Optimistic UI: tracks the (oppId → newStatus) pair while the server
  // catches up. The KanbanDnDCard component uses this to render the
  // card in its NEW column immediately on drop (then snaps back if the
  // server errors). Eliminates the "card sits in old column for 300ms
  // until router.refresh()" lag that made the drag feel sluggish.
  const [optimisticMove, setOptimisticMove] = useState<{ oppId: string; toStatus: string } | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Loading flag specifically for terminal-status nav so we can paint
  // a "Opening debrief…" toast instantly while the new page loads
  // (without it the user sees a 300-800ms blank white between the
  // drop and the detail page paint).
  const [navigating, setNavigating] = useState<string | null>(null);

  const handleDragStart = (
    e: DragEvent<HTMLDivElement>,
    oppId: string,
    accountId?: string
  ) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", oppId);
    setDragOppId(oppId);
    if (accountId) setDragAccountId(accountId);
  };

  const handleDragEnd = () => {
    setDragOppId(null);
    setDragAccountId(null);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>, toStatus: string) => {
    e.preventDefault();
    const oppId = (e.dataTransfer?.getData("text/plain") ?? "") || dragOppId;
    setDragOppId(null);
    if (!oppId) return;

    // Lost / No-bid need loss_reason — bounce to the detail page so
    // the user can pick a reason via the structured DebriefFields
    // (status doesn't flip until the reason lands).
    if (toStatus === "lost" || toStatus === "no_bid") {
      setNavigating(toStatus);
      requestAnimationFrame(() => {
        window.location.href = `/commercial/opportunities/${oppId}?action=change-status&to=${toStatus}`;
      });
      return;
    }

    // OPTIMISTIC UI for non-terminal moves — card visually jumps to
    // the new column IMMEDIATELY. Server call happens in the background;
    // on error, the optimistic state clears and the refresh snaps the
    // card back. Eliminates the 200-500ms "card sits stale" lag.
    setOptimisticMove({ oppId, toStatus });

    // Karan 2026-07-15: the Kanban now surfaces "Proposal Drafted" and
    // "Proposal Sent" as two separate visual columns instead of one
    // "Proposal" column with a sub-status chip. Both map to real DB
    // (status, sub_status) tuples via the mini-shim below — the API
    // itself doesn't need to know these column keys exist.
    //   proposal_drafted → estimating + proposal_pending_approval
    //   proposal_sent    → proposal   + sent
    let apiToStatus = toStatus;
    let apiToSubStatus: string | undefined;
    if (toStatus === "proposal_drafted") {
      apiToStatus = "estimating";
      apiToSubStatus = "proposal_pending_approval";
    } else if (toStatus === "proposal_sent") {
      apiToStatus = "proposal";
      apiToSubStatus = "sent";
    }

    try {
      const res = await fetch(`/api/commercial/opportunities/${oppId}/move-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_status: apiToStatus,
          ...(apiToSubStatus ? { to_sub_status: apiToSubStatus } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 && json.error === "terminal_status_needs_detail_page") {
        // Defensive — server caught a terminal we missed client-side.
        setOptimisticMove(null);
        setNavigating(toStatus);
        requestAnimationFrame(() => {
          window.location.href = `/commercial/opportunities/${oppId}?action=change-status&to=${toStatus}`;
        });
        return;
      }
      if (!res.ok || !json.ok) {
        setOptimisticMove(null); // revert
        flashError(json.error || "Couldn't move that deal.");
        return;
      }
      // Won flips route to the account-scoped debrief page (Karan
      // 2026-07-13: debrief lives under the account, not the opps
      // detail). The API returns `redirect_url` with the resolved
      // /commercial/accounts/[id]/debrief/[dealId] path so the client
      // doesn't need to know account_id up-front.
      if (toStatus === "won") {
        setNavigating("won");
        const nextUrl =
          typeof json.redirect_url === "string" && json.redirect_url
            ? json.redirect_url
            : `/commercial/opportunities/${oppId}?tab=debrief&just_closed=1`;
        requestAnimationFrame(() => {
          window.location.href = nextUrl;
        });
        return;
      }
      // Refresh in a transition so the optimistic card stays in place
      // until the server-rendered payload arrives — no flash of "old"
      // state between optimistic clear + refresh paint.
      // Karan 2026-07-09: dropped from 500ms → 200ms — the SSR round-
      // trip normally lands in ~150-300ms and the fixed 500ms was
      // adding a perceptible "sit and wait" feeling after every drop.
      startTransition(() => {
        router.refresh();
        setTimeout(() => setOptimisticMove(null), 200);
      });
    } catch {
      setOptimisticMove(null);
      flashError("Network error — try again.");
    }
  };

  const flashError = (msg: string) => {
    setError(msg);
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setError(null), 4000);
  };

  return (
    <KanbanDnDContext.Provider
      value={{
        dragOppId,
        dragAccountId,
        optimisticMove,
        onCardDragStart: handleDragStart,
        onCardDragEnd: handleDragEnd,
        onColumnDragOver: handleDragOver,
        onColumnDrop: handleDrop,
        flashError,
      }}
    >
      <div className="relative">
        {error && (
          <div
            role="alert"
            className="fixed inset-x-4 top-4 sm:inset-x-auto sm:top-6 sm:right-6 sm:max-w-md z-50 bg-rose-600 text-white rounded-xl px-4 py-3 text-[13px] font-semibold shadow-2xl border border-rose-700 flex items-start gap-2 animate-fade-up"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 mt-0.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}
        {navigating && (
          <div className="fixed inset-x-0 top-0 z-50 bg-emerald-600 text-white text-sm font-medium py-2 px-4 text-center shadow-md flex items-center justify-center gap-2 animate-fade-up">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Opening {navigating === "won" ? "Win" : navigating === "lost" ? "Loss" : "No-bid"} debrief…
          </div>
        )}
        {children}
      </div>
    </KanbanDnDContext.Provider>
  );
}

import { createContext, useContext } from "react";

type Ctx = {
  dragOppId: string | null;
  dragAccountId: string | null;
  optimisticMove: { oppId: string; toStatus: string } | null;
  onCardDragStart: (e: DragEvent<HTMLDivElement>, oppId: string, accountId?: string) => void;
  onCardDragEnd: () => void;
  onColumnDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onColumnDrop: (e: DragEvent<HTMLDivElement>, toStatus: string) => void;
  flashError: (msg: string) => void;
};

const KanbanDnDContext = createContext<Ctx | null>(null);

/** Wraps a card; makes it draggable. Optional `accountId` prop lets
 *  the DnD provider block cross-account drops on the per-account
 *  mini-kanban layout. Legacy callers without accountId still work —
 *  cross-account blocking is disabled when the source has no account. */
export function KanbanDnDCard({
  oppId,
  accountId,
  children,
}: {
  oppId: string;
  accountId?: string;
  children: ReactNode;
}) {
  const ctx = useContext(KanbanDnDContext);
  if (!ctx) return <>{children}</>;
  const isDragging = ctx.dragOppId === oppId;
  const isOptimisticallyMoved = ctx.optimisticMove?.oppId === oppId;
  return (
    <div
      draggable
      onDragStart={(e) => ctx.onCardDragStart(e, oppId, accountId)}
      onDragEnd={ctx.onCardDragEnd}
      className={`cursor-grab active:cursor-grabbing transition-opacity duration-100 ${
        isOptimisticallyMoved
          ? "opacity-0 pointer-events-none absolute -z-10"
          : isDragging
            ? "opacity-40"
            : "opacity-100"
      }`}
      aria-hidden={isOptimisticallyMoved}
    >
      {children}
    </div>
  );
}

/** Wraps a column; makes it a drop target for the given status.
 *
 *  Karan 2026-07-15 (round 5): optional `boundToAccountId` prop — if
 *  set, the column REFUSES drops from cards belonging to a different
 *  account. Powers the per-account mini-kanban layout where dragging
 *  Card-from-Account-A into Account-B's Won column would (a) succeed
 *  server-side (status flips, account_id doesn't change) then (b)
 *  visually snap back to Account-A's section on refresh — confusing.
 *  Blocked drop shows a friendly toast instead. */
export function KanbanDnDColumn({
  status,
  boundToAccountId,
  children,
}: {
  status: string;
  boundToAccountId?: string;
  children: ReactNode;
}) {
  const ctx = useContext(KanbanDnDContext);
  const [isOver, setIsOver] = useState(false);
  if (!ctx) return <>{children}</>;
  const dragFromDifferentAccount =
    !!boundToAccountId &&
    !!ctx.dragAccountId &&
    ctx.dragAccountId !== boundToAccountId;
  return (
    <div
      onDragOver={(e) => {
        if (dragFromDifferentAccount) return; // don't accept drop
        ctx.onColumnDragOver(e);
        if (!isOver) setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        setIsOver(false);
        if (dragFromDifferentAccount) {
          e.preventDefault();
          ctx.flashError(
            "Cross-customer drops aren't allowed — drop the card in the same customer's section."
          );
          return;
        }
        void ctx.onColumnDrop(e, status);
      }}
      // Karan 2026-07-15: dropped the emerald ring — it read as a
      // floating outline that never felt "seamless." Now we tint the
      // whole column brand-blue on hover with a hairline outline; the
      // drop feels like the target snaps to a soft state rather than
      // wrapping in a badge.
      className={`h-full transition-colors rounded-xl ${
        isOver && ctx.dragOppId
          ? "bg-cc-brand-50/60 outline outline-1 outline-cc-brand-300"
          : ""
      }`}
    >
      {children}
    </div>
  );
}
