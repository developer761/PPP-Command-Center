/**
 * Saved list views — the Salesforce "New This Week ▾" picker.
 *
 * Karan 2026-08-12, from the Opportunities screenshot. The view IS the page
 * identity, not a filter bolted onto a generic list: Kim opens *Proposals Out*,
 * the PM opens *Active Projects*, Alex opens *Needs Attention*. Same list,
 * different saved filters.
 *
 * This is also what replaces the sidebar entries retired in step 8. Proposals,
 * Projects and the six post-job tool indexes were separate pages listing the
 * same rows through different lenses; as views they stop being a parallel app.
 *
 * Every view is defined ONLY in terms of query params the list already
 * supports — no new filtering logic, and therefore no way for a view to show
 * something the toolbar can't also show and explain. Pure, so which view is
 * active is decided by a function rather than by a flag someone has to keep in
 * sync with the URL.
 */

export type SavedView = {
  key: string;
  label: string;
  /** One line under the picker, so a view is never a mystery. */
  hint: string;
  /** The query the view sets. Absent keys are cleared when it is applied. */
  params: Record<string, string>;
  group: "pipeline" | "delivery" | "attention";
};

/** Every param a view may own. Anything here is cleared when switching views,
 *  so leftovers from the previous view can't silently narrow the new one —
 *  the bug where you pick "Active Projects" and still see last view's search. */
export const VIEW_OWNED_PARAMS = [
  "status",
  "lane",
  "mine",
  "new",
  "hot",
  "stale",
  "overdue",
  "coldrfp",
  "followup",
  "archived",
  "sources",
  "sort",
] as const;

// `as const satisfies` and not `: SavedView[]` — the annotation widened every
// key to `string`, so savedViewHref's parameter type accepted anything and the
// "unknown key is caught at build time" guarantee was only ever a runtime
// throw. This keeps the literal keys AND still type-checks each entry.
export const SAVED_VIEWS = [
  {
    key: "all",
    label: "All open",
    hint: "Every live opportunity, newest activity first.",
    params: {},
    group: "pipeline",
  },
  {
    key: "mine",
    label: "My opportunities",
    hint: "Everything you are the estimator on.",
    params: { mine: "1" },
    group: "pipeline",
  },
  {
    key: "new_this_week",
    label: "New this week",
    hint: "Came in over the last seven days.",
    params: { new: "7d" },
    group: "pipeline",
  },
  {
    key: "estimating",
    label: "Estimating",
    // AUDIT 2026-08-12: the hint said "including anything waiting on approval",
    // which stopped being true the moment Pending Approval became its own
    // stage. A view that promises more than it filters is worse than no view.
    hint: "Being priced right now.",
    params: { status: "estimating" },
    group: "pipeline",
  },
  {
    // Brendan's new stage deserves its own view: this IS the approval queue,
    // and it is what the retired sidebar "Proposals" entry was really for.
    key: "pending_approval",
    label: "Pending approval",
    hint: "Priced and waiting on internal sign-off.",
    params: { status: "pending_approval", sort: "oldest" },
    group: "pipeline",
  },
  {
    key: "proposals_out",
    label: "Proposal sent",
    hint: "Out with the GC and waiting on an answer.",
    // AUDIT: was `status: "proposal"`. That still WORKED — the list falls back
    // to mapping a legacy status onto its column — but it meant two different
    // URLs produced the same list while the picker recognised only one, so
    // arriving via a stage chip read "Custom filter". Canonical key now.
    params: { status: "sent", sort: "oldest" },
    group: "pipeline",
  },
  {
    key: "under_contract",
    label: "Under contract",
    hint: "Every job we have been awarded and not yet closed out.",
    params: { lane: "under_contract" },
    group: "delivery",
  },
  {
    key: "won_not_started",
    label: "Awarded",
    hint: "Won, but nobody has mobilised yet.",
    params: { status: "won" },
    group: "delivery",
  },
  {
    key: "active_projects",
    label: "In production",
    hint: "Crews are on site.",
    params: { status: "in_progress" },
    group: "delivery",
  },
  {
    key: "billing",
    label: "Billing",
    hint: "Work is done or nearly done and the money is still moving.",
    params: { status: "billing" },
    group: "delivery",
  },
  {
    key: "overdue",
    label: "Overdue",
    hint: "Past a date they were meant to hit.",
    params: { overdue: "1", sort: "oldest" },
    group: "attention",
  },
  {
    key: "followup",
    label: "Follow-up due",
    hint: "A follow-up is booked and due.",
    params: { followup: "1", sort: "oldest" },
    group: "attention",
  },
  {
    key: "stale",
    label: "Stalled",
    hint: "No movement in a while.",
    params: { stale: "1", sort: "oldest" },
    group: "attention",
  },
  {
    key: "cold_rfp",
    label: "Unquoted RFPs",
    hint: "Plans arrived and nothing has been priced.",
    params: { coldrfp: "1", sort: "oldest" },
    group: "attention",
  },
] as const satisfies readonly SavedView[];

/** The key of a view that actually exists. */
export type SavedViewKey = (typeof SAVED_VIEWS)[number]["key"];

export function savedView(key: string | undefined | null): SavedView | undefined {
  return SAVED_VIEWS.find((v) => v.key === key);
}

/**
 * The canonical URL for a saved view, by key — for links written in code.
 *
 * Karan 2026-08-20. The restructure retired six Post-Job pages and Projects
 * with "they become saved list views", and I redirected all seven to
 * `?view=billing` / `?view=under_contract` / `?view=active_projects`.
 *
 * There is no such param. A view is DERIVED (`activeViewKey` matches on the
 * params actually applied), and `?view=` is the display toggle — list /
 * customer / sheet. `billing` is none of those, so it fell through to the
 * default and every one of those links landed on the WHOLE unfiltered
 * pipeline. Nothing errored: an unfiltered list looks exactly like a filtered
 * one until you count it.
 *
 * So links in code go through here and get the real params. Passing a key that
 * doesn't exist is a build-time error, not a silently unfiltered page.
 */
export function savedViewHref(key: SavedViewKey): string {
  const view = savedView(key);
  if (!view) throw new Error(`Unknown saved view: ${key}`);
  return viewHref(view, {});
}

/**
 * Which view the current URL IS, derived rather than declared.
 *
 * A `?view_key=` param would go stale the moment someone removes a filter chip
 * — you would be looking at "Proposals out" with the proposal filter gone. So
 * the active view is whichever one's params exactly match what is applied, and
 * hand-filtering simply matches nothing.
 */
export function activeViewKey(current: Record<string, string | undefined>): string | null {
  const applied: Record<string, string> = {};
  for (const k of VIEW_OWNED_PARAMS) {
    const v = current[k];
    if (v != null && v !== "") applied[k] = v;
  }
  for (const view of SAVED_VIEWS) {
    const want = view.params;
    const sameSize = Object.keys(want).length === Object.keys(applied).length;
    if (sameSize && Object.entries(want).every(([k, v]) => applied[k] === v)) {
      return view.key;
    }
  }
  return null;
}

/** The href that applies a view, clearing every param a view can own so no
 *  filter survives from the previous one. Non-view params (search, the
 *  list/kanban toggle, an open drawer) are carried through. */
export function viewHref(view: SavedView, current: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v == null || v === "") continue;
    if ((VIEW_OWNED_PARAMS as readonly string[]).includes(k)) continue;
    q.set(k, v);
  }
  for (const [k, v] of Object.entries(view.params)) q.set(k, v);
  const s = q.toString();
  return s ? `/commercial/opportunities?${s}` : "/commercial/opportunities";
}

/** Human-readable chips for what is currently narrowing the list, each with a
 *  URL that removes just that one. "Filtered" with no way to see or undo what
 *  is a list that looks broken. */
export type FilterChip = { key: string; label: string; removeHref: string };

export function filterChips(
  current: Record<string, string | undefined>,
  labelForStatus: (key: string) => string
): FilterChip[] {
  const chips: FilterChip[] = [];
  const without = (drop: string[]) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) {
      if (v == null || v === "" || drop.includes(k)) continue;
      q.set(k, v);
    }
    const s = q.toString();
    return s ? `/commercial/opportunities?${s}` : "/commercial/opportunities";
  };
  const flag = (k: string, label: string) => {
    if (current[k] === "1") chips.push({ key: k, label, removeHref: without([k]) });
  };
  if (current.q) chips.push({ key: "q", label: `“${current.q}”`, removeHref: without(["q"]) });
  if (current.status) {
    chips.push({
      key: "status",
      label: labelForStatus(current.status),
      removeHref: without(["status"]),
    });
  }
  if (current.lane) {
    chips.push({
      key: "lane",
      label: current.lane === "under_contract" ? "Under contract" : "Still selling",
      removeHref: without(["lane"]),
    });
  }
  flag("mine", "Mine");
  if (current.new) chips.push({ key: "new", label: "New this week", removeHref: without(["new"]) });
  flag("overdue", "Overdue");
  flag("followup", "Follow-up due");
  flag("stale", "Gone quiet");
  flag("coldrfp", "Cold RFP");
  flag("hot", "Hot");
  flag("archived", "Including archived");
  if (current.sources) {
    for (const s of current.sources.split(",").filter(Boolean)) {
      const rest = current.sources.split(",").filter((x) => x && x !== s).join(",");
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(current)) {
        if (v == null || v === "" || k === "sources") continue;
        q.set(k, v);
      }
      if (rest) q.set("sources", rest);
      const qs = q.toString();
      chips.push({
        key: `source:${s}`,
        label: s.replace(/_/g, " "),
        removeHref: qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities",
      });
    }
  }
  return chips;
}
