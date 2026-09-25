import {
  appendNickname,
  derivedOppName,
  nicknameAppends,
} from "@/lib/commercial/opportunities/db";

/**
 * What to call a job on screen.
 *
 * Stephanie 2026-08-13: *"Why am I not seeing the job name once it is
 * converted into a project? Only the GC and the address?"*
 *
 * Because `derivedOppName` recomposes "{account} - {client} - {street}" and
 * only falls back to the opportunity's own `title` when it can't build two
 * parts. Any job with a builder and an address therefore displays as the
 * builder and the address — and the name somebody actually typed disappears.
 *
 * Production data (checked, not assumed) shows titles come in two kinds:
 *
 *   Real names, typed by a person:
 *     "Motor Mindz, Babylon" · "Pacos Tacos" · "test title LMJ 123 Main"
 *   Auto-composed boilerplate from AutoOpportunityTitle:
 *     "08-13-2026 Karan Test 1 - Karan's Escape Room - 1500 Old Country Rd"
 *     "08-12-2026 DuCon Construction Co. Inc - DuCon Construction Co. Inc - 4 Henry Street"
 *
 * The first kind is exactly what Stephanie means by the job name, and it is
 * the thing being hidden. The second is noise: it already contains the builder
 * and the street, un-deduplicated, behind a date that means nothing to anyone
 * reading a project list. Showing THAT raw would be worse than today.
 *
 * So: a hand-typed title wins; an auto-composed one falls through to the
 * derived name, which at least dedupes "DuCon - DuCon".
 *
 * The marker is the date prefix, which AutoOpportunityTitle always writes
 * ("MM-DD-YYYY ..."). It is a heuristic, and deliberately a conservative one —
 * misreading a real name as boilerplate only returns today's behaviour, while
 * the reverse would put a date stamp on every project card.
 */

/** "08-13-2026" or "08-13-2026 Something - Else" — the auto-composed shape. */
const AUTO_COMPOSED = /^\d{2}-\d{2}-\d{4}(\s|$)/;

export function isAutoComposedTitle(title: string | null | undefined): boolean {
  return AUTO_COMPOSED.test((title ?? "").trim());
}

export function jobDisplayName(
  opp: {
    title?: string | null;
    title_override?: string | null;
    title_override_mode?: string | null;
    client_name?: string | null;
    property_street?: string | null;
  },
  accountName: string | null | undefined
): string {
  const override = opp.title_override?.trim();

  // An explicit nickname wins outright ONLY when the toggle says replace
  // (Katie 2026-07-20). This function used to return it unconditionally, which
  // meant the opportunity header and every project card ignored Brendan's
  // "Add it to the end of the full name" switch completely — the setting saved,
  // the pipeline list obeyed it, and the page you open next still showed the
  // nickname on its own. Reported as "I pressed the button and it never did
  // anything", and that is exactly what it looked like.
  if (override && !nicknameAppends(opp.title_override_mode)) return override;

  // The base name: a hand-typed title, else the derived one. The nickname is
  // held out of derivedOppName here so the append happens once, in one place,
  // on whichever base wins.
  const title = opp.title?.trim();
  const base =
    title && !isAutoComposedTitle(title)
      ? title
      : (() => {
          // `title: ""` on purpose. The title we have is auto-composed
          // boilerplate, and handing it to derivedOppName just hands it back:
          // "08-13-2026 DuCon - DuCon - 4 Henry Street" is not equal to the
          // deduped computed name, so it does not read as an untouched
          // auto-fill and wins as if a person had typed it. Blanking it sends
          // derivedOppName straight to the computed "{GC} - {client} -
          // {street}", which is the name this function exists to prefer.
          const derived = derivedOppName(
            {
              title: "",
              client_name: opp.client_name ?? null,
              property_street: opp.property_street,
              title_override: null,
            },
            accountName
          );
          // With the title blanked, derivedOppName's last resort is its own
          // "Untitled opportunity" sentinel — which must not be treated as a
          // name and appended to, or a nameless job reads "Untitled
          // opportunity - Building C". A bare date stamp is the same kind of
          // non-name. (Both found by tests against real production rows.)
          return !derived.trim() ||
            derived === "Untitled opportunity" ||
            isAutoComposedTitle(derived)
            ? ""
            : derived;
        })();

  if (override) return appendNickname(base, override);
  // Say what is true: this job has no name yet.
  return base || "Untitled job";
}
