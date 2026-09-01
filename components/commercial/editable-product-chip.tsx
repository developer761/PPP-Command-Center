"use client";

import { useState } from "react";
import ProductPicker, { type PickableProduct } from "@/components/commercial/product-picker";

/**
 * The product on a saved proposal line — changeable, not frozen.
 *
 * Stephanie 2026-08-13: *"Can we not lock inclusion product drop down once it
 * is added and saved? I need to be able to edit without completely removing."*
 *
 * The row used to snapshot its product into a hidden field with no picker, so
 * the only ways out of a mis-picked product were Remove-and-re-add (losing
 * qty, price and phase) or Clear (dropping the catalogue link entirely and
 * retyping the line by hand). Neither is "change the product", which is the
 * ordinary thing an estimator does when they pick the wrong variation.
 *
 * So there are now three moves, in the order they are wanted:
 *
 *   Change  — swap to another catalogue product. Re-uses the same picker as
 *             the add row, so description/unit/price refill exactly as they
 *             did the first time, and the LINK moves too (see product_id in
 *             the update action — a row reading product B while still pointing
 *             at product A would be worse than leaving the field locked).
 *   Clear   — drop the catalogue link and keep the text as a free-text row.
 *   (Remove — still on the row itself, for deleting the line outright.)
 *
 * Nothing commits until Save row, matching every other field here.
 */
export function EditableProductChip({
  name,
  inputId,
  productIdInputId,
  descriptionInputId,
  unitInputId,
  unitPriceInputId,
  products,
  accountId,
}: {
  name: string;
  /** id of the hidden `product_name` input this chip controls. */
  inputId: string;
  /** id of the hidden `product_id` input — the catalogue link. */
  productIdInputId: string;
  descriptionInputId: string;
  unitInputId: string;
  unitPriceInputId: string;
  products: PickableProduct[];
  accountId: string;
}) {
  // A row with no product starts on the "cleared" state, which offers "Pick a
  // product instead" — that is the affordance that makes clearing reversible.
  // Rendering a blank chip would be worse than rendering nothing.
  const [mode, setMode] = useState<"chip" | "changing" | "cleared">(
    name.trim() ? "chip" : "cleared"
  );

  function clearInputs() {
    const pn = document.getElementById(inputId) as HTMLInputElement | null;
    const pid = document.getElementById(productIdInputId) as HTMLInputElement | null;
    if (pn) pn.value = "";
    if (pid) pid.value = "";
  }

  if (mode === "cleared") {
    return (
      <div className="flex items-center gap-2 flex-wrap text-[11.5px] text-ppp-charcoal-500 italic">
        <span>
          {name.trim()
            ? "Product cleared — this becomes a free-text row. Edit the description below, then Save row."
            : "Free-text row — no catalogue product linked."}
        </span>
        <button
          type="button"
          onClick={() => setMode("changing")}
          className="not-italic inline-flex items-center min-h-[44px] text-[11px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 underline underline-offset-2 touch-manipulation"
        >
          {name.trim() ? "Pick a product instead" : "Link a product"}
        </button>
      </div>
    );
  }

  if (mode === "changing") {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-400">
            Change product
          </span>
          <button
            type="button"
            onClick={() => setMode("chip")}
            className="inline-flex items-center min-h-[44px] text-[11px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal-700 underline underline-offset-2 touch-manipulation"
          >
            Keep {name}
          </button>
        </div>
        <ProductPicker
          products={products}
          accountId={accountId}
          descriptionInputId={descriptionInputId}
          unitInputId={unitInputId}
          unitPriceInputId={unitPriceInputId}
          productIdInputId={productIdInputId}
          productNameInputId={inputId}
        />
        <p className="text-[11px] text-ppp-charcoal-400">
          Picking one refills the description, unit and price below. Nothing saves until you press
          Save row.
        </p>
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
        onClick={() => setMode("changing")}
        className="inline-flex items-center min-h-[44px] text-[11px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 underline underline-offset-2 touch-manipulation"
        title="Swap this line to a different catalogue product — quantity, phase and any edits stay."
      >
        Change
      </button>
      <button
        type="button"
        onClick={() => {
          clearInputs();
          setMode("cleared");
        }}
        className="inline-flex items-center min-h-[44px] text-[11px] font-medium text-ppp-charcoal-400 hover:text-rose-700 underline underline-offset-2 touch-manipulation"
        title="Drop the catalogue link and keep this as a free-text row (description kept)."
      >
        Clear
      </button>
    </div>
  );
}
