/**
 * The numbers, computed.
 *
 * Pure — rows in, metrics out — so every calculation is testable and none of
 * it depends on how the data was fetched.
 *
 * Hatch reports Active / Completed / Success% / DropOff% / TakeOver% per
 * workspace. Everything here matches those so the parallel run compares
 * directly, and then goes further in the three places Hatch's shape cannot:
 *
 *   THE FUNNEL      "0% success" and "everybody vanishes at the address
 *                   question" are the same number and different problems.
 *   SPEED TO LEAD   Hatch does not measure it at all, and it is the thing PPP
 *                   is actually buying.
 *   WHY            takeovers with a reason instead of a count.
 */

export type ConversationRow = {
  workspace_name: string;
  state: string;
  outcome: string | null;
  qualification_stage: number;
  takeover_reason: string | null;
  created_at: string;
  ended_at: string | null;
  first_outbound_at: string | null;
  first_inbound_at: string | null;
};

/* ─────────────────────────── the funnel ──────────────────────────── */

export const STAGES = [
  { n: 1, label: "Project details" },
  { n: 2, label: "Full address" },
  { n: 3, label: "Contact info" },
  { n: 4, label: "Availability" },
] as const;

export type FunnelStep = {
  stage: number;
  label: string;
  reached: number;
  /** Share of all conversations that got at least this far. */
  reachedPct: number;
  /** Share of those who reached the PREVIOUS stage and then stopped here.
   *  This is the number that names the problem question. */
  droppedHerePct: number;
};

export function qualificationFunnel(rows: ConversationRow[]): FunnelStep[] {
  const total = rows.length;
  if (total === 0) return STAGES.map((s) => ({ stage: s.n, label: s.label, reached: 0, reachedPct: 0, droppedHerePct: 0 }));

  return STAGES.map((s) => {
    const reached = rows.filter((r) => r.qualification_stage >= s.n).length;
    // Everyone who got to the step before this one. For step 1 that is
    // everybody, since entering the conversation is stage 0.
    const priorReached = s.n === 1 ? total : rows.filter((r) => r.qualification_stage >= s.n - 1).length;
    const droppedHere = priorReached - reached;
    return {
      stage: s.n,
      label: s.label,
      reached,
      reachedPct: pct(reached, total),
      // Guarded: if nobody reached the prior stage, nobody can have dropped at
      // this one, and 0/0 would render as NaN on the page.
      droppedHerePct: priorReached === 0 ? 0 : pct(droppedHere, priorReached),
    };
  });
}

/* ───────────────────────── workspace health ──────────────────────── */

export type WorkspaceHealth = {
  workspace: string;
  active: number;
  completed: number;
  successPct: number;
  dropOffPct: number;
  takeOverPct: number;
  /** Median seconds from conversation start to our first message. Median, not
   *  mean: one conversation that sat over a weekend drags an average into
   *  uselessness while the median still describes a normal lead. */
  medianFirstReplySeconds: number | null;
  /** The stage most conversations died at. Names the question to rewrite. */
  worstStage: { label: string; droppedPct: number } | null;
};

export function workspaceHealth(rows: ConversationRow[]): WorkspaceHealth[] {
  const by = new Map<string, ConversationRow[]>();
  for (const r of rows) {
    const list = by.get(r.workspace_name) ?? [];
    list.push(r);
    by.set(r.workspace_name, list);
  }

  return [...by.entries()]
    .map(([workspace, rs]) => {
      const completed = rs.filter((r) => r.state === "ended");
      const funnel = qualificationFunnel(rs);
      const worst = funnel
        .filter((f) => f.droppedHerePct > 0)
        .sort((a, b) => b.droppedHerePct - a.droppedHerePct)[0];

      return {
        workspace,
        active: rs.filter((r) => r.state !== "ended").length,
        completed: completed.length,
        successPct: pct(completed.filter((r) => r.outcome === "success").length, completed.length),
        dropOffPct: pct(completed.filter((r) => r.outcome === "lost" || r.outcome === "discard").length, completed.length),
        takeOverPct: pct(rs.filter((r) => r.takeover_reason !== null).length, rs.length),
        medianFirstReplySeconds: median(
          rs.map((r) => secondsBetween(r.created_at, r.first_outbound_at)).filter((n): n is number => n !== null)
        ),
        worstStage: worst ? { label: worst.label, droppedPct: worst.droppedHerePct } : null,
      };
    })
    .sort((a, b) => b.completed - a.completed || a.workspace.localeCompare(b.workspace));
}

/* ─────────────────────────── speed to lead ───────────────────────── */

export type SpeedSummary = {
  measured: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  /** Under a minute is the target agreed on 2026-09-02. */
  withinTargetPct: number;
  /** Hatch polls every 15 minutes, so 900s is the floor it can achieve even
   *  when everything else is instant. The comparison PPP is buying. */
  beatingHatchPct: number;
};

export const HATCH_POLL_SECONDS = 900;
export const TARGET_SECONDS = 60;

export function speedSummary(secondsList: (number | null)[]): SpeedSummary {
  const s = secondsList.filter((n): n is number => n !== null && Number.isFinite(n));
  return {
    measured: s.length,
    medianSeconds: median(s),
    p90Seconds: percentile(s, 0.9),
    withinTargetPct: pct(s.filter((n) => n <= TARGET_SECONDS).length, s.length),
    beatingHatchPct: pct(s.filter((n) => n < HATCH_POLL_SECONDS).length, s.length),
  };
}

/* ──────────────────── conversations needing attention ────────────── */

export type AgingConversation = { id: string; workspace: string; waitingSeconds: number };

/**
 * Live conversations where the customer spoke last and nobody has answered.
 *
 * The gap Hatch leaves: it reported Rachel Pope at a 13h 15m average response
 * time and nobody noticed for as long as that average took to form. A number
 * on a dashboard is not an alert.
 */
export function agingConversations(
  rows: { id: string; workspace: string; state: string; lastInboundAt: string | null; lastOutboundAt: string | null }[],
  now: Date,
  thresholdMinutes = 30
): AgingConversation[] {
  const out: AgingConversation[] = [];
  for (const r of rows) {
    if (r.state === "ended" || !r.lastInboundAt) continue;
    // Answered already if our last message came after theirs.
    if (r.lastOutboundAt && new Date(r.lastOutboundAt) > new Date(r.lastInboundAt)) continue;
    const waiting = Math.floor((now.getTime() - new Date(r.lastInboundAt).getTime()) / 1000);
    if (waiting >= thresholdMinutes * 60) {
      out.push({ id: r.id, workspace: r.workspace, waitingSeconds: waiting });
    }
  }
  return out.sort((a, b) => b.waitingSeconds - a.waitingSeconds);
}

/* ──────────────────────────── takeovers ──────────────────────────── */

export function takeoverBreakdown(rows: ConversationRow[]): { reason: string; count: number; pct: number }[] {
  const taken = rows.filter((r) => r.takeover_reason);
  const by = new Map<string, number>();
  for (const r of taken) by.set(r.takeover_reason!, (by.get(r.takeover_reason!) ?? 0) + 1);
  return [...by.entries()]
    .map(([reason, count]) => ({ reason, count, pct: pct(count, taken.length) }))
    .sort((a, b) => b.count - a.count);
}

/* ─────────────────────────── helpers ─────────────────────────────── */

export function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  // Nearest-rank. Clamped so p=1 cannot index past the end.
  const i = Math.min(s.length - 1, Math.ceil(p * s.length) - 1);
  return s[Math.max(0, i)];
}

export function secondsBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = new Date(a).getTime(), y = new Date(b).getTime();
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return Math.max(0, Math.round((y - x) / 1000));
}

/** "45s", "4m", "2h 10m", "3d". A dashboard column has no room for more. */
export function humanSeconds(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return m ? `${h}h ${m}m` : `${h}h`; }
  return `${Math.floor(s / 86400)}d`;
}
