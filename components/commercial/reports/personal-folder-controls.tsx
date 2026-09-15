"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/commercial/submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { PopoverMenu } from "./popover-menu";

type Action = (formData: FormData) => void | Promise<void>;

const INPUT =
  "w-full px-3 min-h-[44px] text-base sm:text-[13px] bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600";

/** The one-field "name your folder" form, used by the rail and the chip row. */
export function NewFolderForm({ view, action, onCancel, className = "" }: { view: string; action: Action; onCancel: () => void; className?: string }) {
  return (
    <form action={action} className={`space-y-1.5 ${className}`}>
      <input type="hidden" name="view" value={view} />
      <label className="block">
        <span className="sr-only">Folder name</span>
        <input name="name" required maxLength={80} autoFocus placeholder="Folder name" className={INPUT} />
      </label>
      <div className="flex gap-1.5">
        <SubmitButton className="flex-1 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700" pendingLabel="Making…">
          Make folder
        </SubmitButton>
        <button type="button" onClick={onCancel} className="px-3 min-h-[44px] rounded-lg text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50">
          Cancel
        </button>
      </div>
      <p className="text-[11.5px] text-ppp-charcoal-500 leading-snug">Only you see your folders. Add reports from the ⋯ on any card.</p>
    </form>
  );
}

/** "+ New folder" in the desktop rail — turns into the form in place. */
export function NewPersonalFolder({ view, action }: { view: string; action: Action }) {
  const [open, setOpen] = useState(false);
  if (open) return <NewFolderForm view={view} action={action} onCancel={() => setOpen(false)} className="px-1 py-1" />;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="w-full flex items-center gap-2 px-2.5 min-h-[44px] rounded-lg text-[13px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50/60 touch-manipulation"
    >
      <span aria-hidden className="inline-flex w-4 justify-center text-[17px] leading-none">+</span> New folder
    </button>
  );
}

/** The ⋯ beside a personal folder's heading: rename, reorder, delete. */
export function PersonalFolderMenu({
  folder,
  view,
  isFirst,
  isLast,
  actions,
}: {
  folder: { id: string; name: string };
  view: string;
  isFirst: boolean;
  isLast: boolean;
  actions: { rename: Action; move: Action; remove: Action };
}) {
  const row =
    "w-full flex items-center gap-2 px-2.5 min-h-[44px] rounded-lg text-[13px] text-ppp-charcoal hover:bg-ppp-charcoal-50 text-left touch-manipulation";
  return (
    <PopoverMenu ariaLabel={`Options for the folder ${folder.name}`}>
      <form action={actions.rename} className="p-1.5 space-y-1.5">
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="folder_id" value={folder.id} />
        <label className="block">
          <span className="block text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-1">Rename</span>
          <input name="name" required maxLength={80} defaultValue={folder.name} className={INPUT} />
        </label>
        <SubmitButton className="w-full min-h-[44px] rounded-lg border border-ppp-charcoal-200 text-[13px] font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50" pendingLabel="Saving…">
          Save name
        </SubmitButton>
      </form>
      <div className="grid grid-cols-2 gap-1 border-t border-ppp-charcoal-100 pt-1 mt-1">
        <form action={actions.move}>
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="folder_id" value={folder.id} />
          <input type="hidden" name="dir" value="up" />
          <SubmitButton disabled={isFirst} className={`${row} justify-center`} pendingLabel="Moving…">↑ Move up</SubmitButton>
        </form>
        <form action={actions.move}>
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="folder_id" value={folder.id} />
          <input type="hidden" name="dir" value="down" />
          <SubmitButton disabled={isLast} className={`${row} justify-center`} pendingLabel="Moving…">↓ Move down</SubmitButton>
        </form>
      </div>
      <form action={actions.remove} className="border-t border-ppp-charcoal-100 pt-1 mt-1">
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="folder_id" value={folder.id} />
        <ConfirmSubmitButton
          message={`Delete the folder “${folder.name}”? The reports inside stay exactly where they are — only this folder goes.`}
          pendingLabel="Deleting…"
          className={`${row} text-rose-700 hover:bg-rose-50`}
        >
          Delete folder
        </ConfirmSubmitButton>
      </form>
    </PopoverMenu>
  );
}
