"use client";

/**
 * Autosaving G703 line row (Karan 2026-07-30: "make sure these autosave").
 * Replaces the per-row Save button. The row owns its field values in client
 * state, so a save-triggered revalidate never clobbers a cell you're still
 * typing in. It saves when focus LEAVES the row (not on every keystroke, not
 * when you tab between cells in the same row) and only when something changed.
 *
 * Audit-hardened (2026-07-30):
 *  - Amount cells are validated with the SAME strict rule as the server
 *    (non-negative, ≤2 decimals). Invalid cells are flagged and block the save
 *    — no more "typed 100.999, silently stored $0, green Saved ✓".
 *  - On save the server returns the STORED values and the row reconciles to
 *    them, so the display can never drift from the DB.
 *  - Retry is a real button, the error shows inline, and a beforeunload guard
 *    warns if you leave with an unsaved / failed row.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { SubmitButton } from "@/components/commercial/submit-button";

export type AiaLineSaveResult =
  | {
      ok: true;
      line: {
        item_no: string | null;
        description: string;
        scheduled_value_cents: number;
        from_previous_cents: number;
        this_period_cents: number;
        materials_stored_cents: number;
      };
    }
  | { ok: false; error?: string };

type Line = {
  id: string;
  item_no: string | null;
  description: string;
  scheduled_value_cents: number;
  from_previous_cents: number;
  this_period_cents: number;
  materials_stored_cents: number;
};

/** Same shape the server accepts: non-negative, up to 2 decimals. Empty = 0. */
const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const MONEY_FIELDS = ["scheduled", "from_previous", "this_period", "materials_stored"] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];

function isValidMoney(s: string): boolean {
  return s.trim() === "" || MONEY_RE.test(s.trim());
}
function dollarsToCents(s: string): number {
  if (s.trim() === "") return 0;
  return MONEY_RE.test(s.trim()) ? Math.round(parseFloat(s) * 100) : 0;
}
function centsToStr(c: number): string {
  return (c / 100).toFixed(2);
}
function fmtCents(c: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
}

const CELL_BASE =
  "w-full px-1.5 py-1 border rounded text-base sm:text-[12px] bg-surface focus:outline-none focus:ring-1 min-h-[44px]";
const CELL_OK = `${CELL_BASE} border-ppp-charcoal-200 focus:ring-cc-brand-500/50`;
const CELL_BAD = `${CELL_BASE} border-rose-400 ring-1 ring-rose-300 focus:ring-rose-400`;

export function AiaLineRow({
  line,
  appId,
  accountId,
  dealId,
  back = "",
  origin = "",
  gridCls,
  saveAction,
  deleteAction,
}: {
  line: Line;
  appId: string;
  accountId: string;
  dealId: string;
  /** Sidebar-tool ?back= origin + inline/route origin, so the delete redirect
   *  returns to WHERE the user is (not the inline deal tab by default). */
  back?: string;
  origin?: string;
  gridCls: string;
  saveAction: (fd: FormData) => Promise<AiaLineSaveResult>;
  deleteAction: (fd: FormData) => void | Promise<void>;
}) {
  const [vals, setVals] = useState({
    item_no: line.item_no ?? "",
    description: line.description ?? "",
    scheduled: centsToStr(line.scheduled_value_cents),
    from_previous: centsToStr(line.from_previous_cents),
    this_period: centsToStr(line.this_period_cents),
    materials_stored: centsToStr(line.materials_stored_cents),
  });
  const dirty = useRef(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const rowRef = useRef<HTMLDivElement>(null);

  // Warn before leaving with an unsaved or failed row (autosave replaced the
  // Save button, so users assume they're safe — make that true).
  useEffect(() => {
    const unsaved = () => dirty.current || status === "saving" || status === "error";
    const handler = (e: BeforeUnloadEvent) => {
      if (unsaved()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [status]);

  const invalid: Record<MoneyField, boolean> = {
    scheduled: !isValidMoney(vals.scheduled),
    from_previous: !isValidMoney(vals.from_previous),
    this_period: !isValidMoney(vals.this_period),
    materials_stored: !isValidMoney(vals.materials_stored),
  };
  const anyInvalid = MONEY_FIELDS.some((f) => invalid[f]);

  const balanceCents =
    dollarsToCents(vals.scheduled) -
    (dollarsToCents(vals.from_previous) + dollarsToCents(vals.this_period) + dollarsToCents(vals.materials_stored));

  function set<K extends keyof typeof vals>(k: K, v: string) {
    setVals((s) => ({ ...s, [k]: v }));
    dirty.current = true;
    if (status === "saved" || status === "error") setStatus("idle");
    setErrMsg(null);
  }

  function save() {
    // Block the save on invalid amounts — otherwise the server coerces them to
    // 0 and reports success (the audit's top finding).
    if (anyInvalid) {
      setStatus("error");
      setErrMsg("Amounts must be numbers with up to 2 decimals (no negatives).");
      return;
    }
    dirty.current = false;
    setStatus("saving");
    setErrMsg(null);
    const fd = new FormData();
    fd.set("app_id", appId);
    fd.set("account_id", accountId);
    fd.set("opp_id", dealId);
    fd.set("line_id", line.id);
    fd.set("item_no", vals.item_no);
    fd.set("description", vals.description);
    fd.set("scheduled", vals.scheduled);
    fd.set("from_previous", vals.from_previous);
    fd.set("this_period", vals.this_period);
    fd.set("materials_stored", vals.materials_stored);
    startTransition(async () => {
      try {
        const res = await saveAction(fd);
        if (res.ok) {
          setStatus("saved");
          // Reconcile to the STORED values — but never stomp a fresh edit the
          // user started while the save was in flight.
          if (!dirty.current) {
            setVals({
              item_no: res.line.item_no ?? "",
              description: res.line.description ?? "",
              scheduled: centsToStr(res.line.scheduled_value_cents),
              from_previous: centsToStr(res.line.from_previous_cents),
              this_period: centsToStr(res.line.this_period_cents),
              materials_stored: centsToStr(res.line.materials_stored_cents),
            });
          }
        } else {
          setStatus("error");
          setErrMsg(res.error ?? "Save failed.");
          dirty.current = true;
        }
      } catch (err) {
        // Never swallow NEXT_REDIRECT — a server action that redirects would
        // have its navigation eaten and the pill would show a false "Save
        // failed" on a save that actually succeeded. Same rule as
        // autosave-form and autosave-proposal-form (audit 2026-08-13).
        if (
          err &&
          typeof (err as { digest?: unknown }).digest === "string" &&
          (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
        ) {
          throw err;
        }
        setStatus("error");
        setErrMsg("Save failed — check your connection.");
        dirty.current = true;
      }
    });
  }

  // Save when focus leaves the ROW entirely (not when tabbing between cells).
  function onBlurCapture(e: React.FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && rowRef.current?.contains(next)) return;
    if (dirty.current && !pending) save();
  }

  const moneyCls = (f: MoneyField) => `${invalid[f] ? CELL_BAD : CELL_OK} text-right tabular-nums`;

  /**
   * Arrow-key movement across the grid.
   *
   * Stephanie 2026-08-20: "Can you add the arrow keys to move between cells on
   * the AIA instead of having to move my hand from the keyboard to get to the
   * cell I want to change or tabbing through?"
   *
   * She is filling a column of numbers down a requisition. Tab walks ACROSS,
   * so reaching the next value in the same column means six tabs or the mouse.
   *
   * Two rules make this feel like a spreadsheet rather than a trap:
   *
   *  - Up/Down move to the SAME COLUMN in the row above/below. Enter does the
   *    same, which is what a decade of spreadsheets has trained into anyone
   *    entering figures. The row saves on the way out because focus leaves it,
   *    which the existing onBlurCapture already handles.
   *  - Left/Right ONLY change cell when the caret is already at the end of the
   *    text. Otherwise they move the caret, because a cell you cannot arrow
   *    through to fix a typo is worse than one you have to tab out of.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    if (el.tagName !== "INPUT") return;
    const input = el as HTMLInputElement;
    if (input.type === "hidden") return;

    const row = rowRef.current;
    if (!row) return;
    const cells = Array.from(
      row.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')
    );
    const col = cells.indexOf(input);
    if (col === -1) return;

    const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
    if (horizontal) {
      // A collapsed caret sitting at the edge of the value is the only time
      // the keypress isn't already meaningful inside the field.
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const end = input.value.length;
      const atEnd = input.selectionStart === end && input.selectionEnd === end;
      if (e.key === "ArrowLeft" && !atStart) return;
      if (e.key === "ArrowRight" && !atEnd) return;
      const next = cells[col + (e.key === "ArrowRight" ? 1 : -1)];
      if (!next) return; // first/last cell — let the row boundary hold
      e.preventDefault();
      next.focus();
      next.select();
      return;
    }

    const down = e.key === "ArrowDown" || e.key === "Enter";
    const up = e.key === "ArrowUp";
    if (!down && !up) return;

    // Sibling rows are separate component instances, so this walks the DOM
    // rather than any shared state.
    const grid = row.parentElement;
    if (!grid) return;
    const rows = Array.from(grid.querySelectorAll<HTMLElement>("[data-aia-row]"));
    const here = rows.indexOf(row);
    const target = rows[here + (down ? 1 : -1)];
    if (!target) {
      // Enter on the last row still commits, rather than submitting a form or
      // doing nothing at all.
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      return;
    }
    const targetCells = Array.from(
      target.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')
    );
    const dest = targetCells[col];
    if (!dest) return;
    e.preventDefault();
    dest.focus();
    dest.select();
  }

  return (
    <div ref={rowRef} data-aia-row onBlur={onBlurCapture} onKeyDown={onKeyDown} className={`${gridCls} relative`}>
      <input aria-label="Item number" value={vals.item_no} onChange={(e) => set("item_no", e.target.value)} className={CELL_OK} />
      <input aria-label="Description" value={vals.description} maxLength={500} onChange={(e) => set("description", e.target.value)} className={CELL_OK} />
      <input aria-label="Scheduled value" inputMode="decimal" value={vals.scheduled} onChange={(e) => set("scheduled", e.target.value)} className={moneyCls("scheduled")} aria-invalid={invalid.scheduled} />
      <input aria-label="From previous" inputMode="decimal" value={vals.from_previous} onChange={(e) => set("from_previous", e.target.value)} className={moneyCls("from_previous")} aria-invalid={invalid.from_previous} />
      <input aria-label="This period" inputMode="decimal" value={vals.this_period} onChange={(e) => set("this_period", e.target.value)} className={moneyCls("this_period")} aria-invalid={invalid.this_period} />
      <input aria-label="Materials stored" inputMode="decimal" value={vals.materials_stored} onChange={(e) => set("materials_stored", e.target.value)} className={moneyCls("materials_stored")} aria-invalid={invalid.materials_stored} />
      <div className="text-right text-[12px] font-semibold tabular-nums text-ppp-charcoal self-center">{fmtCents(balanceCents)}</div>
      <div className="flex items-center justify-end gap-1 self-center">
        <SaveStatus status={status} onRetry={save} />
        <form
          action={deleteAction}
          onSubmit={(e) => {
            if (!confirm("Remove this line?")) e.preventDefault();
          }}
        >
          <input type="hidden" name="app_id" value={appId} />
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="opp_id" value={dealId} />
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="origin" value={origin} />
          <input type="hidden" name="line_id" value={line.id} />
          <SubmitButton
            aria-label="Remove line"
            className="h-[44px] w-[44px] inline-flex items-center justify-center rounded text-ppp-charcoal-400 hover:text-rose-700 hover:bg-rose-50 touch-manipulation"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18 M6 6l12 12" /></svg>
          </SubmitButton>
        </form>
      </div>
      {status === "error" && errMsg && (
        <p role="alert" className="col-span-full text-[10.5px] text-rose-600 mt-0.5 pl-1">{errMsg}</p>
      )}
    </div>
  );
}

function SaveStatus({ status, onRetry }: { status: "idle" | "saving" | "saved" | "error"; onRetry: () => void }) {
  if (status === "saving") return <span className="text-[10px] text-ppp-charcoal-400 tabular-nums">Saving…</span>;
  if (status === "saved")
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700" title="Saved">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
        Saved
      </span>
    );
  if (status === "error")
    return (
      <button type="button" onClick={onRetry} className="text-[10px] font-semibold text-rose-600 underline underline-offset-2 hover:text-rose-700 min-h-[44px] px-1">
        Retry
      </button>
    );
  return <span className="w-[38px]" aria-hidden />;
}
