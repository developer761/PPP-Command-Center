import Link from "next/link";
import { SubmitButton } from "@/components/commercial/submit-button";
import type { InlineField as FieldDef } from "@/lib/commercial/opportunities/inline-fields";

/**
 * One field on the job's Details, editable in place — the Salesforce pencil.
 *
 * Server-rendered, no client JS: which field is open is a URL param (`?ef=`),
 * so clicking a pencil is a navigation and saving is a form post. That is not
 * a shortcut, it is the point — the alternative is a controlled input per
 * field, and this codebase has already been bitten once by React 19
 * form-resetting a half-typed value on the proposal editor. A field with two
 * writers is a field that loses what you typed.
 *
 * The pencil is HIDDEN when the viewer can't save, rather than shown and
 * failing on submit. A control that exists but refuses is worse than one that
 * isn't there.
 */
export function InlineFieldRow({
  field,
  value,
  display,
  editing,
  canEdit,
  editHref,
  cancelHref,
  action,
  oppId,
  error,
}: {
  field: FieldDef;
  /** Raw value for the input (ISO date, number, or text). */
  value: string;
  /** What to show when not editing — already formatted. */
  display: string | null | undefined;
  editing: boolean;
  canEdit: boolean;
  editHref: string;
  cancelHref: string;
  action: (formData: FormData) => void | Promise<void>;
  oppId: string;
  error?: string | null;
}) {
  const hasValue = display != null && display !== "" && display !== "—";

  if (editing && canEdit) {
    return (
      // scroll-mt clears the sticky header when a warning deep-links to this
      // row with #ef-<field>.
      <div className="scroll-mt-28 py-1.5 border-b border-ppp-charcoal-50 last:border-0">
        <form action={action} className="flex flex-col gap-1.5">
          <input type="hidden" name="opp_id" value={oppId} />
          <input type="hidden" name="field" value={field.name} />
          <label
            htmlFor={`ef-${field.name}`}
            className="text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500"
          >
            {field.label}
          </label>
          {field.type === "textarea" ? (
            <textarea
              id={`ef-${field.name}`}
              name="value"
              defaultValue={value}
              rows={3}
              maxLength={field.maxLength}
              autoFocus
              className="w-full rounded-lg border border-cc-brand-300 bg-surface px-2.5 py-2 text-[13px] text-ppp-charcoal focus:outline-none focus:ring-2 focus:ring-cc-brand-200"
            />
          ) : (
            <input
              id={`ef-${field.name}`}
              name="value"
              // text-base on mobile: anything smaller makes iOS zoom the page
              // on focus and it never zooms back.
              type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
              defaultValue={value}
              maxLength={field.maxLength}
              autoFocus
              className="w-full rounded-lg border border-cc-brand-300 bg-surface px-2.5 py-2 text-base sm:text-[13px] text-ppp-charcoal focus:outline-none focus:ring-2 focus:ring-cc-brand-200"
            />
          )}
          {error && <p className="text-[11.5px] text-rose-700 font-medium">{error}</p>}
          {field.hint && !error && (
            <p className="text-[11px] text-ppp-charcoal-500">{field.hint}</p>
          )}
          <div className="flex items-center gap-1.5">
            <SubmitButton
              pendingLabel="Saving…"
              className="inline-flex items-center px-3 py-1.5 rounded-lg bg-cc-brand-600 text-white text-[12px] font-bold hover:bg-cc-brand-700 min-h-[44px] sm:min-h-[32px]"
            >
              Save
            </SubmitButton>
            <Link
              href={cancelHref}
              className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-600 text-[12px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] sm:min-h-[32px]"
            >
              Cancel
            </Link>
            {/* Clearing is an edit, not a failure — without this the only way
                to empty a field is to select-all-delete-save, which people
                reasonably assume won't work. */}
            {value !== "" && (
              <SubmitButton
                // NOT name="value": the text input above already posts that
                // name, FormData keeps both entries in tree order, and
                // formData.get returns the FIRST — so "Clear" saved whatever
                // was in the box instead of emptying it. A separate flag the
                // action checks first is unambiguous.
                name="clear"
                value="1"
                pendingLabel="Clearing…"
                className="inline-flex items-center px-2 py-1.5 rounded-lg text-[11.5px] font-semibold text-ppp-charcoal-500 hover:text-rose-700 min-h-[44px] sm:min-h-[32px]"
              >
                Clear
              </SubmitButton>
            )}
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="group flex items-start justify-between gap-3 py-1.5 border-b border-ppp-charcoal-50 last:border-0">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 shrink-0 pt-0.5">
        {field.label}
      </span>
      <span className="flex items-start gap-1.5 min-w-0">
        <span
          className={`text-[13px] text-right break-words ${
            hasValue ? "font-semibold text-ppp-charcoal" : "italic text-ppp-charcoal-400"
          }`}
        >
          {hasValue ? display : "Not set"}
        </span>
        {canEdit && (
          <Link
            href={editHref}
            aria-label={`Edit ${field.label}`}
            // Always present on touch (no hover to reveal it), fading in on
            // pointer devices so the read view stays calm.
            className="shrink-0 inline-flex items-center justify-center h-11 w-11 sm:h-6 sm:w-6 -my-1 sm:my-0 rounded-md text-ppp-charcoal-400 hover:text-cc-brand-700 hover:bg-cc-brand-50 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 transition-opacity"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </Link>
        )}
      </span>
    </div>
  );
}
