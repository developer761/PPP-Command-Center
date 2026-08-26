"use client";

import { useMemo, useState } from "react";
import ModalPortal from "@/components/modal-portal";
import {
  buildFloorPlan, wallAreaFromPlan, planProblems, versusBoundingRectangle,
  type WallSegment, type FloorPlan,
} from "@/lib/measure/floor-plan";

/**
 * Walk the room, one wall at a time.
 *
 * MOBILE SHAPE. Someone is standing in the room holding a phone and probably a
 * tape. The layout is built around that:
 *   · the plan draws ITSELF as walls go in, so a wrong turn is visible
 *     immediately rather than at the end;
 *   · the number pad opens on a decimal keyboard, one field, big target;
 *   · the current wall is always the last row and always in reach — you never
 *     scroll back up to continue;
 *   · closure is checked continuously, so "you're 2 ft out" arrives while the
 *     tape is still in your hand, not after you've left the house.
 *
 * The turn control is the only genuinely new idea to learn, so it is shown as
 * what you SEE rather than as a compass: most corners go the same way round,
 * and only the notch of an L goes the other. Getting it wrong is
 * self-correcting because the drawing changes under your thumb.
 */

export default function MeasureFloorPlan({
  roomLabel, initialCeilingFt, onApply, onClose,
}: {
  roomLabel: string;
  initialCeilingFt?: string;
  onApply: (r: { floorAreaSqft: number; perimeterLf: number; ceilingFt: number | null; wallCount: number }) => void;
  onClose: () => void;
}) {
  const [walls, setWalls] = useState<WallSegment[]>([]);
  const [draft, setDraft] = useState("");
  const [ceiling, setCeiling] = useState(initialCeilingFt ?? "");

  const plan: FloorPlan = useMemo(() => buildFloorPlan(walls), [walls]);
  const problems = useMemo(() => planProblems(plan, walls), [plan, walls]);
  const comparison = useMemo(() => versusBoundingRectangle(plan), [plan]);
  const wallArea = useMemo(
    () => (plan.closed ? wallAreaFromPlan(plan, parseFloat(ceiling) || 0) : null),
    [plan, ceiling]
  );

  const addWall = () => {
    const n = parseFloat(draft);
    if (!Number.isFinite(n) || n <= 0) return;
    setWalls((ws) => [...ws, { lengthFt: n, turn: "right" }]);
    setDraft("");
  };

  const flipTurn = (i: number) =>
    setWalls((ws) => ws.map((w, j) => (j === i ? { ...w, turn: w.turn === "right" ? "left" : "right" } : w)));

  const removeWall = (i: number) => setWalls((ws) => ws.filter((_, j) => j !== i));

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 bg-white flex flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-ppp-charcoal-100 shrink-0">
          <div className="min-w-0">
            <div className="font-semibold text-ppp-charcoal text-sm truncate">{roomLabel}</div>
            <div className="text-[11px] text-ppp-charcoal-500">
              {walls.length === 0 ? "Start at any corner and walk the room" : `${walls.length} wall${walls.length === 1 ? "" : "s"} · ${plan.perimeterLf} ft so far`}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="shrink-0 h-11 w-11 rounded-lg text-ppp-charcoal-400 hover:bg-ppp-charcoal-50 text-xl touch-manipulation">✕</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <PlanDrawing plan={plan} />

          <div className="px-4 pb-3">
            {plan.closed ? (
              <div className="rounded-xl border border-ppp-green-100 bg-ppp-green-50 px-4 py-3">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <span className="font-condensed text-2xl font-bold text-ppp-navy">
                    {plan.floorAreaSqft.toLocaleString()} sq ft
                  </span>
                  <span className="text-[11px] text-ppp-charcoal-600">
                    {plan.perimeterLf} ft around
                    {wallArea ? ` · ${wallArea.paintableWallSqft.toLocaleString()} sq ft of wall` : ""}
                  </span>
                </div>
                {comparison && comparison.areaDiffPct > 2 && (
                  <div className="text-[11px] text-ppp-charcoal-600 mt-1.5 leading-snug">
                    Measuring this as a plain {Math.round(plan.bounds.maxX - plan.bounds.minX)}′ ×{" "}
                    {Math.round(plan.bounds.maxY - plan.bounds.minY)}′ rectangle would have called it{" "}
                    {comparison.rectAreaSqft.toLocaleString()} sq ft — {comparison.areaDiffPct}% too much
                    ceiling and floor.
                  </div>
                )}
              </div>
            ) : (
              problems.length > 0 && (
                <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 space-y-1">
                  {problems.map((p, i) => (
                    <div key={i} className="text-[12px] text-ppp-orange-700 leading-snug">{p}</div>
                  ))}
                </div>
              )
            )}
          </div>

          <ul className="px-4 space-y-2">
            {walls.map((wall, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="shrink-0 w-7 h-7 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-600 text-[11px] font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="flex-1 text-sm text-ppp-charcoal font-medium">{wall.lengthFt} ft</span>
                {/* The turn belongs to the corner at the END of this wall, so
                    it only means something once another wall follows it. */}
                {i < walls.length - 1 || plan.closed ? (
                  <button
                    type="button" onClick={() => flipTurn(i)}
                    aria-label={`Corner after wall ${i + 1} turns ${wall.turn}. Tap to flip.`}
                    className={`shrink-0 min-h-[44px] px-3 rounded-lg text-xs font-semibold border touch-manipulation transition-colors ${
                      wall.turn === "right"
                        ? "bg-white border-ppp-charcoal-200 text-ppp-charcoal-600"
                        : "bg-ppp-blue-50 border-ppp-blue-200 text-ppp-blue-800"
                    }`}
                  >
                    {wall.turn === "right" ? "turns ↻" : "turns ↺ inward"}
                  </button>
                ) : (
                  <span className="shrink-0 text-[11px] text-ppp-charcoal-400 px-3">last wall</span>
                )}
                <button
                  type="button" onClick={() => removeWall(i)} aria-label={`Remove wall ${i + 1}`}
                  className="shrink-0 h-11 w-11 rounded-lg text-ppp-charcoal-300 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50 touch-manipulation"
                >✕</button>
              </li>
            ))}
          </ul>
        </div>

        {/* Entry pinned to the bottom — always under the thumb, never scrolled
            away from, whatever the list length. */}
        <div className="shrink-0 border-t border-ppp-charcoal-100 p-4 space-y-3">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="sr-only">Length of wall {walls.length + 1} in feet</span>
              <input
                type="number" inputMode="decimal" step="0.1" min="0"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addWall(); } }}
                placeholder={`Wall ${walls.length + 1} — feet`}
                className="w-full px-3 py-3 text-base border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
              />
            </label>
            <button
              type="button" onClick={addWall} disabled={!(parseFloat(draft) > 0)}
              className="shrink-0 min-h-[48px] px-5 rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 active:bg-ppp-blue disabled:opacity-40 transition-colors touch-manipulation"
            >
              Add
            </button>
          </div>

          <div className="flex gap-2 items-end">
            <label className="w-32">
              <span className="block text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1">Ceiling ft</span>
              <input
                type="number" inputMode="decimal" step="0.1" min="0"
                value={ceiling} onChange={(e) => setCeiling(e.target.value)} placeholder="8"
                className="w-full px-3 py-2.5 text-base border border-ppp-charcoal-200 rounded-lg"
              />
            </label>
            <button
              type="button"
              disabled={!plan.closed}
              onClick={() => onApply({
                floorAreaSqft: plan.floorAreaSqft,
                perimeterLf: plan.perimeterLf,
                ceilingFt: parseFloat(ceiling) || null,
                wallCount: walls.filter((w) => w.lengthFt > 0).length,
              })}
              className="flex-1 min-h-[48px] rounded-lg bg-ppp-green text-ppp-navy text-sm font-semibold hover:bg-ppp-green-600 active:bg-ppp-green disabled:opacity-40 transition-colors touch-manipulation"
            >
              {plan.closed ? `Use ${plan.floorAreaSqft.toLocaleString()} sq ft` : "Close the room to finish"}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

/** The plan, drawn to scale and re-fitted on every wall. */
function PlanDrawing({ plan }: { plan: FloorPlan }) {
  const { points, bounds, closed, selfIntersecting } = plan;
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const pad = Math.max(w, h) * 0.12 + 1;
  const vb = `${bounds.minX - pad} ${bounds.minY - pad} ${w + pad * 2} ${h + pad * 2}`;
  const stroke = Math.max(w, h) / 60;

  return (
    <div className="px-4 py-3">
      <div className="rounded-xl border border-ppp-charcoal-100 bg-[var(--color-surface-muted)] aspect-[4/3] flex items-center justify-center overflow-hidden">
        {points.length < 2 ? (
          <p className="text-xs text-ppp-charcoal-400 italic px-6 text-center">
            The room will draw itself here as you add walls.
          </p>
        ) : (
          <svg viewBox={vb} className="w-full h-full" preserveAspectRatio="xMidYMid meet" role="img"
            aria-label={closed ? `Floor plan, ${plan.floorAreaSqft} square feet` : "Floor plan in progress"}>
            {closed && !selfIntersecting && (
              <polygon points={points.slice(0, -1).map((p) => `${p.x},${p.y}`).join(" ")} fill="rgba(43,170,225,0.15)" />
            )}
            <polyline
              points={points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={selfIntersecting ? "#EE662E" : closed ? "#2BAAE1" : "#8DC442"}
              strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round"
            />
            {/* Where you started, so the gap to close is obvious. */}
            <circle cx={points[0].x} cy={points[0].y} r={stroke * 1.6} fill="#172B4D" />
            {!closed && points.length > 1 && (
              <>
                <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={stroke * 1.4} fill="#EE662E" />
                <line
                  x1={points[points.length - 1].x} y1={points[points.length - 1].y}
                  x2={points[0].x} y2={points[0].y}
                  stroke="#EE662E" strokeWidth={stroke * 0.7} strokeDasharray={`${stroke * 2} ${stroke * 2}`} opacity={0.7}
                />
              </>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
