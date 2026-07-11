/**
 * Colored initials avatar for an account. Deterministic hue based on
 * account_id via `accountColorTone`. Used platform-wide so Bob is
 * always the same color — pipeline group cards, invoice rows, activity
 * feed, quick-sheet header, notes, bell notifications, picker options.
 *
 * Karan 2026-07-11 (signature-moments batch): "the color coding on
 * opportunities makes it 100x better — see where else we can add
 * features like that." This is the first extension: the per-account
 * hue+avatar pattern goes everywhere an account is named.
 *
 * Server component (no client-side JS). Pass `accountId` + `name` and
 * it renders the initials circle with the account's tone. Size preset
 * `sm` (24px) for compact rows, `md` (28px) for standard, `lg` (36px)
 * for hero surfaces.
 */

import { accountColorTone, extractInitials } from "@/lib/commercial/account-tone";

export type AccountAvatarSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASSES: Record<AccountAvatarSize, string> = {
  xs: "w-5 h-5 text-[9px]",
  sm: "w-6 h-6 text-[10px]",
  md: "w-7 h-7 text-[11px]",
  lg: "w-9 h-9 text-[13px]",
};

export function AccountAvatar({
  accountId,
  name,
  size = "md",
  className = "",
}: {
  accountId: string | null | undefined;
  name: string | null | undefined;
  size?: AccountAvatarSize;
  className?: string;
}) {
  const tone = accountColorTone(accountId);
  const initials = extractInitials(name);
  return (
    <span
      aria-hidden
      className={`shrink-0 inline-flex items-center justify-center rounded-full font-bold ${SIZE_CLASSES[size]} ${className}`}
      style={tone.avatar}
      title={name ?? undefined}
    >
      {initials}
    </span>
  );
}
