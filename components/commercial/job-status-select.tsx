"use client";

/** Tiny select that submits its parent form on change - moves a job's status
 *  on the Job Board without a separate button. */
export function JobStatusSelect({
  value,
  options,
}: {
  value: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      name="status"
      defaultValue={value}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
      className="text-[11px] font-semibold text-ppp-charcoal-600 bg-ppp-charcoal-50 rounded px-1.5 py-1 outline-none cursor-pointer hover:bg-ppp-charcoal-100 min-h-[32px]"
      aria-label="Move job status"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
