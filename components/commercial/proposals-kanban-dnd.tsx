"use client";

/**
 * <ProposalsKanbanDnD> — Karan 2026-07-15
 *
 * Client-side drag-and-drop wrapper for the /commercial/proposals
 * kanban. Wraps the server-rendered columns + cards and hooks up:
 *
 *   - draggable cards (via <ProposalDnDCard>)
 *   - droppable columns (via <ProposalDnDColumn>)
 *   - drop into Won → POST /api/commercial/proposals/[id]/outcome {to:"won"}
 *   - drop into Lost → POST + client redirect into the account debrief
 *     page so Alex captures loss_reason (mirrors the proposal-editor
 *     Mark Lost button behavior)
 *   - optimistic hide on the source card so the drop reads as instant
 *     even before router.refresh() paints the new column (same pattern
 *     as commercial-kanban-dnd.tsx after the 2026-07-15 drag-lag fix)
 *
 * The parent server page rebuilds the layout from DB state, so we don't
 * need to re-slot cards client-side — just hide the source card and let
 * the refresh reveal the card in its new lane.
 */

import { createContext, useContext, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

type OutcomeDrop = { to: "won" | "lost" };

type Ctx = {
  dragProposalId: string | null;
  optimisticMove: { proposalId: string; toStatus: string } | null;
  onCardDragStart: (e: React.DragEvent, proposalId: string, sourceStatus: string) => void;
  onCardDragEnd: () => void;
  onColumnDragOver: (e: React.DragEvent) => void;
  onColumnDrop: (e: React.DragEvent, targetStatus: string) => void;
};

const ProposalsDnDContext = createContext<Ctx | null>(null);

// Only Sent proposals can be dropped into Won/Lost — those are the
// terminal outcome transitions the server helper honors. Any other
// drop is silently rejected client-side (no toast noise; the card
// snaps back).
const OUTCOME_TARGET_STATUSES = new Set(["won", "lost"]);
const SOURCE_STATUS_FOR_OUTCOME = "sent";

export function ProposalsKanbanDnDProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [dragProposalId, setDragProposalId] = useState<string | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<string | null>(null);
  const [optimisticMove, setOptimisticMove] = useState<
    { proposalId: string; toStatus: string } | null
  >(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashError = (msg: string) => {
    setError(msg);
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setError(null), 4000);
  };

  const onCardDragStart = (
    e: React.DragEvent,
    proposalId: string,
    sourceStatus: string
  ) => {
    setDragProposalId(proposalId);
    setDragSourceStatus(sourceStatus);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", proposalId);
  };

  const onCardDragEnd = () => {
    setDragProposalId(null);
    setDragSourceStatus(null);
  };

  const onColumnDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const onColumnDrop = async (e: React.DragEvent, targetStatus: string) => {
    e.preventDefault();
    const proposalId = e.dataTransfer.getData("text/plain") || dragProposalId;
    const sourceStatus = dragSourceStatus;
    setDragProposalId(null);
    setDragSourceStatus(null);
    if (!proposalId) return;
    if (!OUTCOME_TARGET_STATUSES.has(targetStatus)) {
      // Dropped into a column that's not Won/Lost — silently ignore
      // (server helper only handles those two anyway).
      return;
    }
    if (sourceStatus !== SOURCE_STATUS_FOR_OUTCOME) {
      flashError("Only Sent proposals can be marked Won or Lost. Bump a new revision instead.");
      return;
    }
    setOptimisticMove({ proposalId, toStatus: targetStatus });
    try {
      const res = await fetch(
        `/api/commercial/proposals/${proposalId}/outcome`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: targetStatus as "won" | "lost" } satisfies OutcomeDrop),
        }
      );
      if (!res.ok) {
        setOptimisticMove(null);
        let msg = "Move failed.";
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch {}
        flashError(msg);
        return;
      }
      const json = (await res.json()) as {
        redirect_url?: string | null;
      };
      if (json.redirect_url) {
        // Lost → route to the account debrief page so Alex captures
        // loss_reason. Keep the optimistic-hidden state until nav
        // happens so the card doesn't flash back into Sent.
        window.location.href = json.redirect_url;
        return;
      }
      // Won → refresh the server-rendered board so the card lands in
      // its new column. Keep the optimistic-hide flag on for another
      // 200ms so no "sit in old column" flash between refresh + paint.
      startTransition(() => {
        router.refresh();
        setTimeout(() => setOptimisticMove(null), 200);
      });
    } catch {
      setOptimisticMove(null);
      flashError("Network error — try again.");
    }
  };

  return (
    <ProposalsDnDContext.Provider
      value={{
        dragProposalId,
        optimisticMove,
        onCardDragStart,
        onCardDragEnd,
        onColumnDragOver,
        onColumnDrop,
      }}
    >
      {error && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 max-w-sm bg-rose-600 text-white text-sm font-semibold px-4 py-2.5 rounded-lg shadow-lg"
        >
          {error}
        </div>
      )}
      {children}
    </ProposalsDnDContext.Provider>
  );
}

export function ProposalDnDColumn({
  status,
  children,
  className,
}: {
  status: string;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useContext(ProposalsDnDContext);
  const isOutcomeTarget = OUTCOME_TARGET_STATUSES.has(status);
  const isActive =
    ctx?.dragProposalId != null && isOutcomeTarget;
  if (!ctx) return <div className={className}>{children}</div>;
  return (
    <div
      className={`${className ?? ""} ${
        isActive ? "ring-2 ring-emerald-400 ring-offset-1" : ""
      }`}
      onDragOver={isOutcomeTarget ? ctx.onColumnDragOver : undefined}
      onDrop={isOutcomeTarget ? (e) => ctx.onColumnDrop(e, status) : undefined}
    >
      {children}
    </div>
  );
}

export function ProposalDnDCard({
  proposalId,
  sourceStatus,
  children,
}: {
  proposalId: string;
  sourceStatus: string;
  children: ReactNode;
}) {
  const ctx = useContext(ProposalsDnDContext);
  if (!ctx) return <>{children}</>;
  const isDragging = ctx.dragProposalId === proposalId;
  const isOptimisticallyMoved = ctx.optimisticMove?.proposalId === proposalId;
  const draggable = sourceStatus === SOURCE_STATUS_FOR_OUTCOME;
  return (
    <div
      draggable={draggable}
      onDragStart={
        draggable ? (e) => ctx.onCardDragStart(e, proposalId, sourceStatus) : undefined
      }
      onDragEnd={draggable ? ctx.onCardDragEnd : undefined}
      className={`transition-opacity duration-100 ${
        isOptimisticallyMoved
          ? "opacity-0 pointer-events-none absolute -z-10"
          : isDragging
            ? "opacity-40 cursor-grabbing"
            : draggable
              ? "cursor-grab"
              : ""
      }`}
      aria-hidden={isOptimisticallyMoved}
      title={draggable ? "Drag onto the Won or Lost column to mark this proposal's outcome" : undefined}
    >
      {children}
    </div>
  );
}
