"use client";

import { useState } from "react";

/**
 * Editable product chip for a proposal line-item edit row.
 *
 * 2026-07-21 audit fix: an edit row snapshots its product name in a hidden
 * field with no picker, so a mis-picked variation was a dead-end (only
 * recovery was Remove + re-add, losing qty/price/phase). This renders the
 * product chip with a "Clear" control that blanks the hidden product_name
 * input — on Save the row becomes a normal free-text line (the description
 * is kept + editable), which the update path already supports.
 */
export function EditableProductChip({
  name,
  inputId,
}: {
  name: string;
  /** id of the hidden `product_name` input this chip controls. */
  inputId: string;
}) {
  const [cleared, setCleared] = useState(false);

  if (cleared) {
    return (
      <div className="text-[11.5px] text-ppp-charcoal-500 italic">
        Product cleared — this becomes a free-text row. Edit the description below, then Save row.
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 flex-wrap">
      <span className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-400 pt-1 shrink-0">
        Product
      </span>
      <span className="inline-flex items-center rounded-md border border-ppp-navy-100 bg-ppp-navy-50 px-2 py-0.5 text-[12.5px] font-semibold text-ppp-navy-700 max-w-full break-words">
        {name}
      </span>
      <button
        type="button"
        onClick={() => {
          const el = document.getElementById(inputId) as HTMLInputElement | null;
          if (el) el.value = "";
          setCleared(true);
        }}
        className="inline-flex items-center min-h-[32px] text-[11px] font-medium text-ppp-charcoal-400 hover:text-rose-600 underline underline-offset-2 touch-manipulation"
        title="Remove the linked product — the row becomes free-text (description kept). Wrong product? Clear it or Remove the row and re-add."
      >
        Clear
      </button>
    </div>
  );
}
