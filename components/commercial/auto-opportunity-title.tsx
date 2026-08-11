"use client";

/**
 * Auto-composes the opportunity title as "MM-DD-YYYY Builder - Client - Street"
 * (Karan meeting 2026-08). Defaults from today's date + the account (builder) +
 * the Client name and Project street fields in the same form, updating live as
 * those change — but STOPS auto-composing the moment the user edits the title by
 * hand (so a manual title is never clobbered). Empty parts are omitted so a
 * blank client/street doesn't leave dangling " - " separators.
 *
 * `builder` is optional: on the pipeline's New-opportunity sheet the customer
 * is chosen client-side, so the component falls back to reading the account
 * picker's visible input and recomposes as the user picks one.
 */

import { useEffect, useRef, useState } from "react";

function todayMMDDYYYY(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("month")}-${g("day")}-${g("year")}`;
}

export function AutoOpportunityTitle({
  builder = "",
  builderFieldId,
  className,
}: {
  builder?: string;
  /** Id of a client-side account input to read the builder name from when
   *  `builder` isn't known at render time (the pipeline sheet's picker). */
  builderFieldId?: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const touchedRef = useRef(false);
  // Seeded with the date on the FIRST render, not "" — the previous version
  // rendered an empty input on the server and composed in useEffect, so the
  // field visibly flashed blank before filling in. The date is the one part
  // that never depends on other fields, so it can be there from the start.
  const [value, setValue] = useState(() => todayMMDDYYYY());

  useEffect(() => {
    const input = ref.current;
    const form = input?.closest("form");
    if (!form) return;
    const clientEl = form.querySelector<HTMLInputElement>('[name="client_name"]');
    const streetEl = form.querySelector<HTMLInputElement>('[name="property_street"]');
    const builderEl = builderFieldId
      ? form.querySelector<HTMLInputElement>(`#${CSS.escape(builderFieldId)}`)
      : null;
    const compose = () => {
      if (touchedRef.current) return;
      const builderName = (builder || builderEl?.value || "").trim();
      const parts = [builderName, (clientEl?.value ?? "").trim(), (streetEl?.value ?? "").trim()].filter(Boolean);
      setValue(`${todayMMDDYYYY()}${parts.length ? " " + parts.join(" - ") : ""}`);
    };
    compose(); // seed on mount
    // "change" as well as "input": a custom picker (searchable select, datalist
    // pick, autofill) may set a value without emitting an input event, which
    // would otherwise leave the title stale.
    const events: (keyof HTMLElementEventMap)[] = ["input", "change"];
    const targets = [clientEl, streetEl, builderEl].filter(Boolean) as HTMLInputElement[];
    for (const el of targets) for (const ev of events) el.addEventListener(ev, compose);
    return () => {
      for (const el of targets) for (const ev of events) el.removeEventListener(ev, compose);
    };
  }, [builder, builderFieldId]);

  return (
    <input
      ref={ref}
      id="deal-title"
      type="text"
      name="title"
      required
      maxLength={200}
      value={value}
      onChange={(e) => {
        touchedRef.current = true;
        setValue(e.target.value);
      }}
      className={className}
      placeholder="MM-DD-YYYY Builder - Client - Street"
    />
  );
}
