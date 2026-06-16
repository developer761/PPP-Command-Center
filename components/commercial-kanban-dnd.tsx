"use client";

import { useState, useRef, type DragEvent, type ReactNode } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, oppId: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", oppId);
    setDragOppId(oppId);
  };

  const handleDragEnd = () => setDragOppId(null);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>, toStatus: string) => {
    e.preventDefault();
    const oppId = e.dataTransfer.getData("text/plain") || dragOppId;
    setDragOppId(null);
    if (!oppId) return;
    try {
      const res = await fetch(`/api/commercial/opportunities/${oppId}/move-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_status: toStatus }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 && json.error === "terminal_status_needs_detail_page") {
        // Won / Lost / No-bid need loss_reason — bounce to the detail
        // page with the preselected target status.
        window.location.href = `/commercial/opportunities/${oppId}?action=change-status&to=${toStatus}`;
        return;
      }
      if (!res.ok || !json.ok) {
        flashError(json.error || "Couldn't move that deal.");
        return;
      }
      router.refresh();
    } catch {
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
        {children}
      </div>
    </KanbanDnDContext.Provider>
  );
}

import { createContext, useContext } from "react";

type Ctx = {
  dragOppId: string | null;
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
      className={`cursor-grab active:cursor-grabbing transition-opacity ${
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
      className={`h-full transition-shadow ${
        isOver && ctx.dragOppId
          ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-ppp-charcoal-50 rounded-xl"
          : ""
      }`}
    >
      {children}
    </div>
  );
}
