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

type OutcomeDrop = { to: "won" | "lost" | "sent" };

type Ctx = {
  dragProposalId: string | null;
  dragSourceStatus: string | null;
  optimisticMove: { proposalId: string; toStatus: string } | null;
  onCardDragStart: (e: React.DragEvent, proposalId: string, sourceStatus: string) => void;
  onCardDragEnd: () => void;
  onColumnDragOver: (e: React.DragEvent) => void;
  onColumnDrop: (e: React.DragEvent, targetStatus: string) => void;
  isValidDropTarget: (sourceStatus: string, targetStatus: string) => boolean;
};

const ProposalsDnDContext = createContext<Ctx | null>(null);

// Karan 2026-07-15: the kanban supports two flows —
//   (a) Sent → Won or Sent → Lost  = mark outcome (via markProposalOutcome)
//   (b) Won → Sent or Lost → Sent  = REOPEN (via reopenProposal) so an
//       accidental Won drop has an undo path.
// Any other drop is silently rejected client-side.
const OUTCOME_TARGETS_FROM_SENT = new Set(["won", "lost"]);
const REOPEN_SOURCE_STATUSES = new Set(["won", "lost"]);
const REOPEN_TARGET_STATUS = "sent";

function isValidDropTargetFn(sourceStatus: string, targetStatus: string): boolean {
  if (sourceStatus === "sent" && OUTCOME_TARGETS_FROM_SENT.has(targetStatus)) return true;
  if (REOPEN_SOURCE_STATUSES.has(sourceStatus) && targetStatus === REOPEN_TARGET_STATUS) return true;
  return false;
}

export function ProposalsKanbanDnDProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [dragProposalId, setDragProposalId] = useState<string | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<string | null>(null);
  const [optimisticMove, setOptimisticMove] = useState<
    { proposalId: string; toStatus: string } | null
  >(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashError = (msg: string) => {
    setError(msg);
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setError(null), 4000);
  };
  const flashSuccess = (msg: string) => {
    setSuccess(msg);
    if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    successTimeoutRef.current = setTimeout(() => setSuccess(null), 4500);
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
    if (!proposalId || !sourceStatus) return;
    if (!isValidDropTargetFn(sourceStatus, targetStatus)) {
      // Not a supported transition — silently snap back. E.g. dragging
      // a Draft into Won, or a Won into Lost (must reopen to Sent first).
      return;
    }
    setOptimisticMove({ proposalId, toStatus: targetStatus });
    try {
      const res = await fetch(
        `/api/commercial/proposals/${proposalId}/outcome`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: targetStatus as "won" | "lost" | "sent",
          } satisfies OutcomeDrop),
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
        reopened?: boolean;
        deal_reopened?: boolean;
        deal_current_status?: string;
      };
      if (json.redirect_url) {
        // Lost → route to the account debrief page so Alex captures
        // loss_reason. Keep optimistic-hidden state until nav lands
        // so the card doesn't flash back into Sent.
        window.location.href = json.redirect_url;
        return;
      }
      // Success toast so Karan can SEE that the deal was flipped too
      // (previous silent refresh left him wondering "did the deal
      // update or just the proposal?").
      if (targetStatus === "won") {
        flashSuccess(
          "🎉 Marked won. Parent deal flipped to Pre-Sale Closed · Won."
        );
      } else if (targetStatus === "sent" && json.reopened) {
        flashSuccess(
          json.deal_reopened
            ? "Reopened. Proposal back to Sent, parent deal back to Proposal · Sent."
            : `Reopened proposal only. Parent deal already moved to ${json.deal_current_status ?? "a later stage"}, left as-is.`
        );
      }
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
        dragSourceStatus,
        optimisticMove,
        onCardDragStart,
        onCardDragEnd,
        onColumnDragOver,
        onColumnDrop,
        isValidDropTarget: isValidDropTargetFn,
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
      {success && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 max-w-sm bg-emerald-600 text-white text-sm font-semibold px-4 py-2.5 rounded-lg shadow-lg"
        >
          {success}
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
  if (!ctx) return <div className={className}>{children}</div>;
  const isValidTarget =
    ctx.dragSourceStatus != null &&
    ctx.isValidDropTarget(ctx.dragSourceStatus, status);
  // Won-source dropping into Sent = reopen (blue ring instead of emerald
  // so it visually reads as "undo" not "close").
  const isReopenTarget =
    isValidTarget && ctx.dragSourceStatus !== "sent" && status === "sent";
  const ringCls = isValidTarget
    ? isReopenTarget
      ? "ring-2 ring-cc-brand-500 ring-offset-1"
      : "ring-2 ring-emerald-400 ring-offset-1"
    : "";
  return (
    <div
      className={`${className ?? ""} ${ringCls}`}
      onDragOver={isValidTarget ? ctx.onColumnDragOver : undefined}
      onDrop={isValidTarget ? (e) => ctx.onColumnDrop(e, status) : undefined}
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
  // Sent → can be dragged into Won or Lost (mark outcome).
  // Won / Lost → can be dragged back into Sent (reopen — undo path).
  // Draft / Pending / Expired / Replaced → not draggable on this board.
  const draggable =
    sourceStatus === "sent" ||
    sourceStatus === "won" ||
    sourceStatus === "lost";
  const title = !draggable
    ? undefined
    : sourceStatus === "sent"
      ? "Drag onto Won or Lost to close this bid"
      : "Dragged you into Won/Lost by mistake? Drag back onto Sent to reopen — the parent deal reopens too.";
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
      title={title}
    >
      {children}
    </div>
  );
}
