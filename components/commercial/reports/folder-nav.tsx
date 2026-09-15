"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FolderGlyph } from "./folder-glyph";
import { NewFolderForm, NewPersonalFolder } from "./personal-folder-controls";

type Action = (formData: FormData) => void | Promise<void>;

export type FolderNavItem = {
  /** "all" or a folder id. */
  id: string;
  label: string;
  icon: string;
  count: number;
  kind: "all" | "shared" | "personal";
};

function href(id: string) {
  return `/commercial/reports?folder=${encodeURIComponent(id)}`;
}

/**
 * Folder navigation for the Reports index.
 *
 * Desktop: a left rail in three labelled sections — All reports, Team folders,
 * My folders. Phone: one row of chips that scrolls sideways INSIDE itself (the
 * page never does), with the open folder scrolled into view — on a 400px screen
 * the folder you're in can otherwise sit off the edge, which reads as "nothing
 * is selected".
 */
export function FolderNav({
  items,
  activeId,
  sharedLabel,
  createAction,
}: {
  items: FolderNavItem[];
  activeId: string | null;
  sharedLabel: string;
  createAction: Action;
}) {
  const view = activeId ?? "";
  const all = items.filter((i) => i.kind === "all");
  const shared = items.filter((i) => i.kind === "shared");
  const personal = items.filter((i) => i.kind === "personal");

  return (
    <>
      {/* ── Desktop rail ── */}
      <nav aria-label="Report folders" className="hidden lg:block w-60 shrink-0 self-start sticky top-4 space-y-4">
        {all.length > 0 && (
          <ul className="space-y-0.5">
            {all.map((i) => <RailLink key={i.id} item={i} active={i.id === activeId} />)}
          </ul>
        )}
        {shared.length > 0 && (
          <div>
            <p className="px-2.5 mb-1 font-condensed text-[11px] font-bold uppercase tracking-[0.14em] text-ppp-charcoal-500">{sharedLabel}</p>
            <ul className="space-y-0.5">
              {shared.map((i) => <RailLink key={i.id} item={i} active={i.id === activeId} />)}
            </ul>
          </div>
        )}
        <div>
          <p className="px-2.5 mb-1 font-condensed text-[11px] font-bold uppercase tracking-[0.14em] text-ppp-charcoal-500">My folders</p>
          <ul className="space-y-0.5">
            {personal.map((i) => <RailLink key={i.id} item={i} active={i.id === activeId} />)}
          </ul>
          <NewPersonalFolder view={view} action={createAction} />
        </div>
      </nav>

      {/* ── Phone / tablet chip row ── */}
      <ChipRow all={all} shared={shared} personal={personal} activeId={activeId} view={view} createAction={createAction} />
    </>
  );
}

function RailLink({ item, active }: { item: FolderNavItem; active: boolean }) {
  return (
    <li>
      <Link
        href={href(item.id)}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-2.5 px-2.5 min-h-[44px] rounded-lg text-[13.5px] transition-colors touch-manipulation ${
          active
            ? "bg-cc-brand-50 text-ppp-charcoal font-semibold ring-1 ring-inset ring-cc-brand-200"
            : "text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
        }`}
      >
        <FolderGlyph icon={item.icon} size={16} className={active ? "text-cc-brand-700 shrink-0" : "text-ppp-charcoal-400 shrink-0"} />
        <span className="truncate flex-1">{item.label}</span>
        <span className={`tabular-nums text-[11.5px] font-semibold ${active ? "text-cc-brand-700" : "text-ppp-charcoal-400"}`}>{item.count}</span>
      </Link>
    </li>
  );
}

function ChipRow({
  all,
  shared,
  personal,
  activeId,
  view,
  createAction,
}: {
  all: FolderNavItem[];
  shared: FolderNavItem[];
  personal: FolderNavItem[];
  activeId: string | null;
  view: string;
  createAction: Action;
}) {
  const [creating, setCreating] = useState(false);
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    // Centre the open folder without scrolling the page vertically.
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activeId]);

  const chip = (i: FolderNavItem) => {
    const active = i.id === activeId;
    return (
      <Link
        key={i.id}
        ref={active ? activeRef : undefined}
        href={href(i.id)}
        aria-current={active ? "page" : undefined}
        className={`shrink-0 inline-flex items-center gap-1.5 pl-3 pr-2.5 min-h-[44px] rounded-full border text-[13px] font-semibold touch-manipulation transition-colors ${
          active
            ? "bg-ppp-navy-700 border-ppp-navy-700 text-white"
            : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-700"
        }`}
      >
        <FolderGlyph icon={i.icon} size={14} className={active ? "text-white/85" : "text-ppp-charcoal-400"} />
        <span className="max-w-[11rem] truncate">{i.label}</span>
        <span className={`tabular-nums text-[11px] min-w-[20px] h-5 px-1.5 inline-flex items-center justify-center rounded-full ${active ? "bg-white/20 text-white" : "bg-ppp-charcoal-100 text-ppp-charcoal-600"}`}>
          {i.count}
        </span>
      </Link>
    );
  };

  const divider = <span aria-hidden className="shrink-0 w-px h-6 bg-ppp-charcoal-200 self-center" />;

  return (
    <div className="lg:hidden space-y-2">
      <nav aria-label="Report folders" className="-mx-4 sm:-mx-6">
        <div className="flex items-center gap-2 overflow-x-auto px-4 sm:px-6 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {all.map(chip)}
          {all.length > 0 && shared.length > 0 && divider}
          {shared.map(chip)}
          {(all.length > 0 || shared.length > 0) && personal.length > 0 && divider}
          {personal.map(chip)}
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            aria-expanded={creating}
            className="shrink-0 inline-flex items-center gap-1 px-3.5 min-h-[44px] rounded-full border border-dashed border-ppp-charcoal-300 text-[13px] font-semibold text-cc-brand-700 bg-surface touch-manipulation"
          >
            <span aria-hidden className="text-[17px] leading-none">+</span> {personal.length === 0 ? "My folder" : "New"}
          </button>
        </div>
      </nav>
      {creating && (
        <div className="rounded-xl border border-ppp-charcoal-100 bg-surface p-3">
          <NewFolderForm view={view} action={createAction} onCancel={() => setCreating(false)} />
        </div>
      )}
    </div>
  );
}
