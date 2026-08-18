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

import { createContext, useContext, useRef, useState, useTransition, useEffect } from "react";
import { proposalStatusLabel } from "@/lib/commercial/proposals/constants";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

type OutcomeDrop = { to: string };

type Ctx = {
  dragProposalId: string | null;
  dragSourceStatus: string | null;
  optimisticMove: { proposalId: string; toStatus: string } | null;
  onCardDragStart: (e: React.DragEvent, proposalId: string, sourceStatus: string) => void;
  onCardDragEnd: () => void;
  onColumnDragOver: (e: React.DragEvent) => void;
  onColumnDrop: (e: React.DragEvent, targetStatus: string) => void;
  isValidDropTarget: (sourceStatus: string, targetStatus: string) => boolean;
  /** The same move a drop performs, reachable without a mouse. HTML5 drag
   *  events never fire on touch, so on a phone this board was a read-only wall
   *  — and it is the DEFAULT view, on the surface Alex opens every morning. */
  moveProposal: (proposalId: string, sourceStatus: string, targetStatus: string) => void;
};

const ProposalsDnDContext = createContext<Ctx | null>(null);

// Karan 2026-07-15: fully free drag — every proposal can move to any
// other column. Server-side helpers handle the routing:
//   won/lost              → cascades parent deal via markProposalOutcome
//   sent (from won/lost)  → uncascades via reopenProposal
//   any other transition  → plain status flip via updateProposalStatus
// UI just needs: source status ≠ target status. Same-column drops are
// no-ops (nothing to change).
function isValidDropTargetFn(sourceStatus: string, targetStatus: string): boolean {
  return sourceStatus !== targetStatus;
}

/** The columns this board renders, in board order — the move menu offers
 *  exactly these, so tapping can reach every lane a drag can. Kept here rather
 *  than imported from the page so the client bundle doesn't pull the page in. */
const MOVE_TARGETS = [
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "won",
  "lost",
  "expired",
] as const;

/** "Draft" is labelled "Current proposal" on this board (only the current
 *  revision per deal renders here) — the menu must say the same thing the
 *  column header says, or the two disagree about where the card is going. */
const MOVE_LABEL: Record<string, string> = { draft: "Current proposal" };
const moveLabel = (s: string) => MOVE_LABEL[s] ?? proposalStatusLabel(s);

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
  // When Lost is dropped, we stash the debrief URL so the success
  // toast can include a "Add loss reason" link instead of force-navigating.
  const [lostDebriefUrl, setLostDebriefUrl] = useState<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Karan 2026-07-16: in-flight guard. Root cause of "took 3 tries and
  // moved 2 other cards too": each drop fires an API call. If the user
  // doesn't see immediate feedback (router.refresh() takes 200-500ms),
  // they drag AGAIN. If the SOURCE card was already hidden by the
  // optimistic UI, the second drag grabs a DIFFERENT card, third drag
  // grabs a third. Result: three API calls, three cards moved.
  //
  // Ref (not state) so the check inside the async handler always sees
  // the latest value without a stale closure. Also drives a full-page
  // "Moving proposal…" overlay so the user knows the drop registered.
  const inFlightRef = useRef(false);
  const [inFlight, setInFlight] = useState(false);

  const flashError = (msg: string) => {
    setError(msg);
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setError(null), 4000);
  };
  const flashSuccess = (msg: string) => {
    setSuccess(msg);
    setLostDebriefUrl(null); // clear any prior lost link on new toast
    if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    // Lost toast gets 8s (needs time to click the debrief link); others 4.5s.
    const dwell = msg.toLowerCase().includes("lost") ? 8000 : 4500;
    successTimeoutRef.current = setTimeout(() => {
      setSuccess(null);
      setLostDebriefUrl(null);
    }, dwell);
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
    await moveProposal(proposalId, sourceStatus, targetStatus);
  };

  // The move itself — shared by the drop handler and the tap-driven "Move"
  // menu, so touch and mouse take EXACTLY the same path (in-flight lock,
  // optimistic hide, cascade toasts, debrief link and all).
  const moveProposal = async (
    proposalId: string,
    sourceStatus: string,
    targetStatus: string
  ) => {
    if (!isValidDropTargetFn(sourceStatus, targetStatus)) {
      // Not a supported transition — silently snap back. E.g. same
      // column drop, or invalid combination.
      return;
    }
    // Karan 2026-07-16: block concurrent drops. If a move is in flight,
    // silently ignore new drops until the current one finishes + the
    // page has refreshed. Prior behavior: 3 fast drags = 3 API calls
    // = 3 cards moved (each drag caught a different card because the
    // previous source was already hidden by optimistic UI).
    if (inFlightRef.current) {
      flashError("Still moving — hold on a second and try again.");
      return;
    }
    inFlightRef.current = true;
    setInFlight(true);
    setOptimisticMove({ proposalId, toStatus: targetStatus });
    try {
      const res = await fetch(
        `/api/commercial/proposals/${proposalId}/outcome`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: targetStatus } satisfies OutcomeDrop),
        }
      );
      if (!res.ok) {
        setOptimisticMove(null);
        inFlightRef.current = false;
        setInFlight(false);
        let msg = "Move failed.";
        try {
          const j = (await res.json()) as { error?: string; detail?: string };
          // Prefer the human-readable `detail` the outcome route returns
          // for guard rejections; fall back to `error`, then the default.
          if (j.detail || j.error) msg = j.detail ?? j.error ?? msg;
        } catch {}
        flashError(msg);
        return;
      }
      const json = (await res.json()) as {
        redirect_url?: string | null;
        debrief_url?: string | null;
        reopened?: boolean;
        deal_reopened?: boolean;
        deal_current_status?: string;
        skipped_approval?: boolean;
      };
      if (json.redirect_url) {
        // Keep optimistic-hidden state until nav lands so the card
        // doesn't flash back into its source column. Leave inFlight
        // set — the page is navigating away, no more drops possible.
        window.location.href = json.redirect_url;
        return;
      }
      // Success toast so Karan can SEE that the deal was flipped too
      // (previous silent refresh left him wondering "did the deal
      // update or just the proposal?").
      if (targetStatus === "won") {
        flashSuccess(
          json.skipped_approval
            ? "Marked won — heads up: this proposal was never approved, so an un-vetted price is now the contract. Open it to review."
            : "Marked won. Parent opportunity flipped to Pre-Sale Closed · Won."
        );
      } else if (targetStatus === "lost") {
        // Stash debrief link in state so the toast can render as a
        // link rather than force-navigating (Karan 2026-07-15).
        // MUST set AFTER flashSuccess: flashSuccess() clears lostDebriefUrl
        // on every new toast, so setting it first would be wiped in the same
        // render tick and the debrief link would never appear (2026-07-28 audit).
        flashSuccess("Marked lost. Parent opportunity flipped to Pre-Sale Closed · Lost.");
        setLostDebriefUrl(json.debrief_url ?? null);
      } else if (targetStatus === "sent" && json.reopened) {
        // Reopen path (Won/Lost → Sent) — has its own toast because
        // the parent-deal cascade may or may not have fired.
        flashSuccess(
          json.deal_reopened
            ? "Reopened. Proposal back to Sent, parent opportunity back to Proposal · Sent."
            : `Reopened proposal only. Parent deal already moved to ${json.deal_current_status ?? "a later stage"}, left as-is.`
        );
      } else {
        // Generic status flip (Draft ↔ Pending, Sent → Expired, any →
        // Replaced, etc.) — the parent deal is NOT cascaded for these,
        // just the proposal.
        flashSuccess(`Moved to ${targetStatus.replace(/_/g, " ")}.`);
      }
      startTransition(() => {
        router.refresh();
        // Give the refresh a bit more time (600ms) to paint the new
        // state before we clear optimistic + release the in-flight
        // lock. If we release too early the user can drag again while
        // the server-rendered payload is still in flight — same class
        // of "3 tries moved 3 cards" bug the lock is designed to
        // prevent.
        setTimeout(() => {
          setOptimisticMove(null);
          inFlightRef.current = false;
          setInFlight(false);
        }, 600);
      });
    } catch {
      setOptimisticMove(null);
      inFlightRef.current = false;
      setInFlight(false);
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
        moveProposal,
      }}
    >
      {/* Karan 2026-07-16: visible "Moving…" pill so the user knows
          the drop registered. Prior UI hid the source card only; on a
          slow refresh the user thought nothing happened and dragged
          again — three tries dragged three cards. Now the pill sits
          top-center while the move is in flight (~600ms) and drops
          are blocked. */}
      {inFlight && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-ppp-navy-900 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg flex items-center gap-2 animate-fade-up"
        >
          <svg
            className="animate-spin"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Moving proposal…
        </div>
      )}
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
          className="fixed bottom-6 right-6 z-50 max-w-sm bg-emerald-600 text-white text-sm font-semibold px-4 py-2.5 rounded-lg shadow-lg flex items-start gap-3"
        >
          <span className="flex-1">{success}</span>
          {lostDebriefUrl && (
            <a
              href={lostDebriefUrl}
              className="shrink-0 underline underline-offset-2 hover:text-white/80"
            >
              Add loss reason →
            </a>
          )}
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
  // Karan 2026-07-15 (round 2): HTML5 DnD's `dragleave` fires when
  // the pointer crosses INTO a child element (leaves the parent
  // boundary momentarily). That's why the emerald ring was flickering
  // + sometimes sticking after Karan moved a card around. Fix: track
  // enter/leave with a counter ref — increment on dragenter, decrement
  // on dragleave; only clear the ring when the counter hits 0.
  const [isOver, setIsOver] = useState(false);
  const enterCountRef = useRef(0);
  // Reset defensively when the drag ends (user aborts by hitting Esc,
  // or drops outside any column). Without this the ring can linger.
  useEffect(() => {
    if (!ctx?.dragProposalId) {
      enterCountRef.current = 0;
      if (isOver) setIsOver(false);
    }
  }, [ctx?.dragProposalId, isOver]);
  if (!ctx) return <div className={className}>{children}</div>;
  const isValidTarget =
    ctx.dragSourceStatus != null &&
    ctx.isValidDropTarget(ctx.dragSourceStatus, status);
  return (
    <div
      className={`${className ?? ""} transition-colors rounded-xl ${
        isOver && isValidTarget
          ? "bg-cc-brand-50/60 outline outline-1 outline-cc-brand-300 outline-offset-0"
          : ""
      }`}
      onDragEnter={
        isValidTarget
          ? (e) => {
              e.preventDefault();
              enterCountRef.current += 1;
              if (!isOver) setIsOver(true);
            }
          : undefined
      }
      onDragOver={
        isValidTarget
          ? (e) => {
              // preventDefault is what tells the browser this element
              // is a valid drop target (fires the drop event).
              ctx.onColumnDragOver(e);
            }
          : undefined
      }
      onDragLeave={
        isValidTarget
          ? () => {
              enterCountRef.current = Math.max(0, enterCountRef.current - 1);
              if (enterCountRef.current === 0) setIsOver(false);
            }
          : undefined
      }
      onDrop={
        isValidTarget
          ? (e) => {
              enterCountRef.current = 0;
              setIsOver(false);
              ctx.onColumnDrop(e, status);
            }
          : undefined
      }
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
  // Karan 2026-07-15 (round 3): EVERY proposal is draggable — the API
  // + shared updateProposalStatus helper accept every source→target
  // combination now. Previously the client hard-coded `draggable` to
  // only sent/won/lost sources, so dragging a Draft or Pending Approval
  // card just failed silently (no cursor change, no error) — read to
  // Karan as "the kanban is glitching out." Now: pick up any card,
  // drop it anywhere.
  const draggable = true;
  const title = "Drag onto any column to move — parent opportunity follows automatically.";
  return (
    <div
      className={`relative group/card transition-opacity duration-100 ${
        isOptimisticallyMoved
          ? "opacity-0 pointer-events-none absolute -z-10"
          : isDragging
            ? "opacity-40"
            : ""
      }`}
      aria-hidden={isOptimisticallyMoved}
    >
      {/* Tap-driven move. HTML5 drag-and-drop is mouse-only: `dragstart` never
          fires from a touch, so on a phone every card on this board was inert
          — and the kanban is the DEFAULT view here. This runs the identical
          moveProposal path, so the cascade, the toasts and the in-flight lock
          are the same whichever way you move a card. Always visible on touch
          (no hover to reveal it), fades in on hover for pointer users. */}
      <details className="absolute top-1 right-1 z-20 sm:opacity-0 sm:group-hover/card:opacity-100 sm:focus-within:opacity-100 transition-opacity">
        <summary
          className="list-none cursor-pointer select-none inline-flex items-center justify-center h-7 min-w-[28px] px-1.5 rounded-md border border-ppp-charcoal-200 bg-surface/95 backdrop-blur text-[10px] font-bold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 shadow-sm"
          aria-label="Move this proposal to another column"
          title="Move to…"
        >
          Move ▾
        </summary>
        <div className="absolute right-0 mt-1 min-w-[168px] rounded-lg border border-ppp-charcoal-200 bg-surface shadow-xl p-1">
          {MOVE_TARGETS.filter((s) => s !== sourceStatus).map((s) => (
            <button
              key={s}
              type="button"
              onClick={(e) => {
                // Close the menu, then move. Without closing first the popover
                // survives the refresh and hangs over the re-rendered board.
                (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                ctx.moveProposal(proposalId, sourceStatus, s);
              }}
              className="w-full text-left px-2.5 py-2 rounded-md text-[12px] font-medium text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:text-cc-brand-800 min-h-[36px]"
            >
              {moveLabel(s)}
            </button>
          ))}
        </div>
      </details>
    <div
      draggable={draggable}
      onDragStart={
        draggable ? (e) => ctx.onCardDragStart(e, proposalId, sourceStatus) : undefined
      }
      onDragEnd={draggable ? ctx.onCardDragEnd : undefined}
      className={isDragging ? "cursor-grabbing" : draggable ? "cursor-grab" : ""}
      title={title}
    >
      {children}
    </div>
    </div>
  );
}
