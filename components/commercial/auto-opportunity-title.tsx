"use client";

/**
 * Auto-composes the opportunity title as "MM-DD-YYYY Builder - Client - Street"
 * (Karan meeting 2026-08). Defaults from today's date + the account (builder) +
 * the Client name and Project street fields in the same form, updating live as
 * those change — but STOPS auto-composing the moment the user edits the title by
 * hand (so a manual title is never clobbered). Empty parts are omitted so a
 * blank client/street doesn't leave dangling " - " separators.
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
  builder,
  className,
}: {
  builder: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const touchedRef = useRef(false);
  const [value, setValue] = useState("");

  useEffect(() => {
    const input = ref.current;
    const form = input?.closest("form");
    if (!form) return;
    const clientEl = form.querySelector<HTMLInputElement>('[name="client_name"]');
    const streetEl = form.querySelector<HTMLInputElement>('[name="property_street"]');
    const compose = () => {
      if (touchedRef.current) return;
      const parts = [builder.trim(), (clientEl?.value ?? "").trim(), (streetEl?.value ?? "").trim()].filter(Boolean);
      setValue(`${todayMMDDYYYY()}${parts.length ? " " + parts.join(" - ") : ""}`);
    };
    compose(); // seed on mount
    clientEl?.addEventListener("input", compose);
    streetEl?.addEventListener("input", compose);
    return () => {
      clientEl?.removeEventListener("input", compose);
      streetEl?.removeEventListener("input", compose);
    };
  }, [builder]);

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
