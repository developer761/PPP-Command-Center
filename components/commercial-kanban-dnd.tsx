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

  const handleDragStart = (e: DragEvent<HTMLDivElement>, oppId: string) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", oppId);
    setDragOppId(oppId);
  };

  const handleDragEnd = () => setDragOppId(null);

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

    try {
      const res = await fetch(`/api/commercial/opportunities/${oppId}/move-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_status: toStatus }),
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
      // Won flips like any other status, but we ALSO route the user to
      // the opp page so the DebriefOnlyCard is right there for optional
      // structured-debrief follow-through. Server already dropped the
      // placeholder auto-note in the move-status API.
      if (toStatus === "won") {
        setNavigating("won");
        requestAnimationFrame(() => {
          window.location.href = `/commercial/opportunities/${oppId}?tab=debrief&just_closed=1`;
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
        optimisticMove,
        onCardDragStart: handleDragStart,
        onCardDragEnd: handleDragEnd,
        onColumnDragOver: handleDragOver,
        onColumnDrop: handleDrop,
      }}
    >
      <div className="relative">
        {error && (
          <div className="fixed top-4 right-4 z-50 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-4 py-2 text-sm shadow-lg">
            {error}
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
  optimisticMove: { oppId: string; toStatus: string } | null;
  onCardDragStart: (e: DragEvent<HTMLDivElement>, oppId: string) => void;
  onCardDragEnd: () => void;
  onColumnDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onColumnDrop: (e: DragEvent<HTMLDivElement>, toStatus: string) => void;
};

const KanbanDnDContext = createContext<Ctx | null>(null);

/** Wraps a card; makes it draggable. */
export function KanbanDnDCard({ oppId, children }: { oppId: string; children: ReactNode }) {
  const ctx = useContext(KanbanDnDContext);
  if (!ctx) return <>{children}</>;
  return (
    <div
      draggable
      onDragStart={(e) => ctx.onCardDragStart(e, oppId)}
      onDragEnd={ctx.onCardDragEnd}
      // Karan 2026-07-09: dropped `transition-opacity` — the 150ms fade
      // during drag felt like a lag on the way in and on the way out.
      // Instant opacity switch reads as snappier + more direct.
      className={`cursor-grab active:cursor-grabbing ${
        ctx.dragOppId === oppId ? "opacity-40" : "opacity-100"
      }`}
    >
      {children}
    </div>
  );
}

/** Wraps a column; makes it a drop target for the given status. */
export function KanbanDnDColumn({
  status,
  children,
}: {
  status: string;
  children: ReactNode;
}) {
  const ctx = useContext(KanbanDnDContext);
  const [isOver, setIsOver] = useState(false);
  if (!ctx) return <>{children}</>;
  return (
    <div
      onDragOver={(e) => {
        ctx.onColumnDragOver(e);
        if (!isOver) setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        setIsOver(false);
        void ctx.onColumnDrop(e, status);
      }}
      // No transition — the ring should snap in/out as the card enters
      // and leaves the column so the drop feels precise, not delayed.
      className={`h-full ${
        isOver && ctx.dragOppId
          ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-ppp-charcoal-50 rounded-xl"
          : ""
      }`}
    >
      {children}
    </div>
  );
}
