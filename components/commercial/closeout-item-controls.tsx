"use client";

/**
 * Autosaving close-out checklist controls (Karan 2026-07-30). The Include
 * toggle + status select save the instant you change them — no Save button, no
 * page jump. Discrete values (no free text), so we save on change and show a
 * quiet Saving / Saved / Retry. The save action RETURNS a result (never
 * redirects) so it stays in place.
 */
import { useState, useTransition } from "react";
import { SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

type ItemStatus = "pending" | "received" | "na";
const STATUS_LABEL: Record<ItemStatus, string> = { pending: "Pending", received: "Received", na: "N/A" };

export function CloseoutItemControls({
  itemId,
  pkgId,
  accountId,
  dealId,
  kind,
  label,
  included: initIncluded,
  itemStatus: initStatus,
  includeEditable,
  saveAction,
}: {
  itemId: string;
  pkgId: string;
  accountId: string;
  dealId: string;
  kind: string;
  label: string;
  included: boolean;
  itemStatus: ItemStatus;
  includeEditable: boolean;
  saveAction: (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [included, setIncluded] = useState(initIncluded);
  const [itemStatus, setItemStatus] = useState<ItemStatus>(initStatus);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function save(nextIncluded: boolean, nextStatus: ItemStatus) {
    setStatus("saving");
    setErrMsg(null);
    const fd = new FormData();
    fd.set("account_id", accountId);
    fd.set("opp_id", dealId);
    fd.set("pkg_id", pkgId);
    fd.set("item_id", itemId);
    fd.set("kind", kind);
    fd.set("label", label);
    fd.set("included", nextIncluded ? "on" : "");
    fd.set("item_status", nextStatus);
    startTransition(async () => {
      try {
        const res = await saveAction(fd);
        if (res.ok) setStatus("saved");
        else {
          setStatus("error");
          setErrMsg(res.error ?? "Save failed.");
        }
      } catch {
        setStatus("error");
        setErrMsg("Save failed — check your connection.");
      }
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      {includeEditable && (
        <label className="inline-flex items-center gap-1.5 text-[12px] text-ppp-charcoal-600 min-h-[44px]">
          <input
            type="checkbox"
            checked={included}
            onChange={(e) => {
              setIncluded(e.target.checked);
              save(e.target.checked, itemStatus);
            }}
            className="w-4 h-4 accent-cc-brand-600"
          />
          Include
        </label>
      )}
      <select
        aria-label="Item status"
        value={itemStatus}
        onChange={(e) => {
          const v = e.target.value as ItemStatus;
          setItemStatus(v);
          save(included, v);
        }}
        className={`${SELECT_CLS} !min-h-[44px] !py-1 text-base sm:text-[12px] w-[7.5rem]`}
        style={SELECT_BG_STYLE}
      >
        {(["pending", "received", "na"] as ItemStatus[]).map((s) => (
          <option key={s} value={s}>{STATUS_LABEL[s]}</option>
        ))}
      </select>
      <SaveStatus status={status} errMsg={errMsg} onRetry={() => save(included, itemStatus)} />
    </div>
  );
}

function SaveStatus({ status, errMsg, onRetry }: { status: "idle" | "saving" | "saved" | "error"; errMsg: string | null; onRetry: () => void }) {
  if (status === "saving") return <span className="text-[10px] text-ppp-charcoal-400 w-12">Saving…</span>;
  if (status === "saved")
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700 w-12" title="Saved">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
        Saved
      </span>
    );
  if (status === "error")
    return (
      <button type="button" onClick={onRetry} className="text-[10px] font-semibold text-rose-600 underline underline-offset-2 min-h-[44px] px-1 w-12" title={errMsg ?? "Save failed"}>
        Retry
      </button>
    );
  return <span className="w-12" aria-hidden />;
}
