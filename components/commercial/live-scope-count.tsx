"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "N of M lines" for the work order's scope picker, counted from the BOXES
 * rather than from the database.
 *
 * The count used to be server-rendered from `wo.scope_line_item_ids`, which was
 * only correct because every autosave revalidated the deal route and re-rendered
 * the whole page. Once background saves stopped revalidating (they were
 * re-rendering the form mid-type — Stephanie's "it saves every 3 seconds and
 * erases what I type"), that count would have frozen: tick three lines and the
 * label still reads "all of it", which reads as "my ticks didn't take".
 *
 * Counting the checkboxes is also strictly more correct than what it replaced.
 * The server number always lagged by a save cycle even when revalidation was on,
 * so a tick showed the PREVIOUS count for a beat. This one is right immediately,
 * and stays right whether or not the page ever refreshes.
 */
export function LiveScopeCount({
  total,
  initialSelected,
}: {
  total: number;
  /** Server-rendered count, so the first paint matches and hydration is clean. */
  initialSelected: number;
}) {
  const [n, setN] = useState(initialSelected);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const recount = () =>
      setN(form.querySelectorAll('input[name="scope_ids"]:checked').length);
    // Recount once on mount too: React may have restored checkbox state from a
    // bfcache navigation without firing any change event.
    recount();
    form.addEventListener("change", recount);
    return () => form.removeEventListener("change", recount);
  }, []);

  return (
    <span ref={ref} className="text-ppp-charcoal-400 font-normal">
      {n === 0
        ? "all of it — tick lines to split the job across crews"
        : `${n} of ${total} lines`}
    </span>
  );
}
