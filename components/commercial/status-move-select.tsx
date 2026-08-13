"use client";

import { useRef, useTransition } from "react";
import { JOB_STATUSES, jobStatusLabel, type JobStatus } from "@/lib/commercial/field-ops/job-constants";
import { SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

/**
 * Field Ops → Status board. A compact status dropdown on each work-order card
 * that submits its parent <form action={moveStatusAction}> the moment the
 * status changes (no separate "save" tap). Kept as a tiny client island so the
 * board itself stays a server component. Shows a subtle pending state while the
 * server action revalidates.
 */
export function StatusMoveSelect({ current }: { current: JobStatus }) {
  const ref = useRef<HTMLSelectElement | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <select
      ref={ref}
      name="status"
      defaultValue={current}
      aria-label="Move to status"
      disabled={pending}
      onChange={(e) => {
        const form = e.currentTarget.form;
        if (form) startTransition(() => form.requestSubmit());
      }}
      className={`${SELECT_CLS} ${pending ? "opacity-50" : ""} text-base sm:!text-[12px] min-h-[44px]`}
      style={SELECT_BG_STYLE}
    >
      {JOB_STATUSES.map((s) => (
        <option key={s} value={s}>
          {jobStatusLabel(s as JobStatus)}
        </option>
      ))}
    </select>
  );
}
