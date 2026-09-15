"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/commercial/submit-button";
import { PopoverMenu } from "./popover-menu";
import { FolderGlyph } from "./folder-glyph";

type Action = (formData: FormData) => void | Promise<void>;

/**
 * The ⋯ on a report card: file this report into your own folders.
 *
 * Personal folders only. Shared folders grant access to other people, so they
 * change in Settings → Report folders where that is visible and deliberate —
 * not from a menu on a card.
 */
export function ReportCardMenu({
  reportKey,
  reportTitle,
  view,
  personalFolders,
  inCurrentPersonalFolder,
  position,
  actions,
}: {
  reportKey: string;
  reportTitle: string;
  /** The view the index is on, carried back through each action. */
  view: string;
  personalFolders: { id: string; name: string; icon: string; has: boolean }[];
  /** Set when the open view is a personal folder holding this report. */
  inCurrentPersonalFolder: { folderId: string; isFirst: boolean; isLast: boolean } | null;
  position: string;
  actions: {
    add: Action;
    remove: Action;
    move: Action;
    create: Action;
  };
}) {
  const [naming, setNaming] = useState(false);
  const row =
    "w-full flex items-center gap-2.5 px-2.5 min-h-[44px] rounded-lg text-[13px] text-ppp-charcoal hover:bg-ppp-charcoal-50 text-left touch-manipulation";

  return (
    <PopoverMenu ariaLabel={`Options for ${reportTitle}`}>
      {inCurrentPersonalFolder && (
        <div className="pb-1.5 mb-1.5 border-b border-ppp-charcoal-100">
          <p className="px-2.5 pt-1 pb-1 text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">This folder · {position}</p>
          <div className="grid grid-cols-2 gap-1">
            <form action={actions.move}>
              <Hidden view={view} folderId={inCurrentPersonalFolder.folderId} reportKey={reportKey} />
              <input type="hidden" name="dir" value="up" />
              <SubmitButton disabled={inCurrentPersonalFolder.isFirst} className={`${row} justify-center`} pendingLabel="Moving…">
                ← Earlier
              </SubmitButton>
            </form>
            <form action={actions.move}>
              <Hidden view={view} folderId={inCurrentPersonalFolder.folderId} reportKey={reportKey} />
              <input type="hidden" name="dir" value="down" />
              <SubmitButton disabled={inCurrentPersonalFolder.isLast} className={`${row} justify-center`} pendingLabel="Moving…">
                Later →
              </SubmitButton>
            </form>
          </div>
          <form action={actions.remove}>
            <Hidden view={view} folderId={inCurrentPersonalFolder.folderId} reportKey={reportKey} />
            <SubmitButton className={`${row} text-rose-700 hover:bg-rose-50`} pendingLabel="Removing…">
              Remove from this folder
            </SubmitButton>
          </form>
        </div>
      )}

      <p className="px-2.5 pt-1 pb-1 text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Add to my folders</p>
      {personalFolders.length === 0 && !naming && (
        <p className="px-2.5 pb-1.5 text-[12px] text-ppp-charcoal-500 leading-snug">
          Folders you make are just for you — a tidy view of the reports you use most.
        </p>
      )}
      <ul className="max-h-60 overflow-y-auto">
        {personalFolders.map((f) => (
          <li key={f.id}>
            <form action={f.has ? actions.remove : actions.add}>
              <Hidden view={view} folderId={f.id} reportKey={reportKey} />
              <SubmitButton
                className={row}
                aria-label={f.has ? `Remove ${reportTitle} from ${f.name}` : `Add ${reportTitle} to ${f.name}`}
                pendingLabel={f.has ? "Removing…" : "Adding…"}
              >
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded border shrink-0 ${f.has ? "bg-cc-brand-600 border-cc-brand-600 text-white" : "border-ppp-charcoal-300"}`} aria-hidden>
                  {f.has && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                  )}
                </span>
                <FolderGlyph icon={f.icon} size={15} className="text-ppp-charcoal-400 shrink-0" />
                <span className="truncate">{f.name}</span>
              </SubmitButton>
            </form>
          </li>
        ))}
      </ul>

      {naming ? (
        <form action={actions.create} className="mt-1 p-1.5 border-t border-ppp-charcoal-100 space-y-1.5">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="report_key" value={reportKey} />
          <label className="block">
            <span className="sr-only">New folder name</span>
            <input
              name="name"
              required
              maxLength={80}
              autoFocus
              placeholder="Folder name, e.g. Monday review"
              className="w-full px-3 min-h-[44px] text-base sm:text-[13px] bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600"
            />
          </label>
          <div className="flex gap-1.5">
            <SubmitButton className="flex-1 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700" pendingLabel="Making…">
              Make folder
            </SubmitButton>
            <button type="button" onClick={() => setNaming(false)} className="px-3 min-h-[44px] rounded-lg text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-1 pt-1 border-t border-ppp-charcoal-100">
          <button type="button" onClick={() => setNaming(true)} className={`${row} font-semibold text-cc-brand-700`}>
            <span aria-hidden className="inline-flex h-5 w-5 items-center justify-center text-[18px] leading-none">+</span>
            New folder with this report
          </button>
        </div>
      )}
    </PopoverMenu>
  );
}

function Hidden({ view, folderId, reportKey }: { view: string; folderId: string; reportKey: string }) {
  return (
    <>
      <input type="hidden" name="view" value={view} />
      <input type="hidden" name="folder_id" value={folderId} />
      <input type="hidden" name="report_key" value={reportKey} />
    </>
  );
}
