/**
 * Shared Banner primitive for the Commercial CC (Karan 2026-07-07).
 *
 * Replaces the ad-hoc amber/blue/rose banner divs scattered across the
 * platform that had drifted into inconsistent border widths, icon
 * treatments, and CTA styles. One card shape, four semantic variants,
 * icon puck + title + body + optional CTA. Matches the KpiCard signature
 * (3px left-accent stripe, gradient tint, rounded-xl, shadow-sm).
 *
 * Variants:
 *   - info    → blue    → "here's context / something to know"
 *   - warn    → amber   → "needs your attention"
 *   - success → emerald → "money in / paid / won"
 *   - danger  → rose    → "overdue / failed / blocked"
 *
 * Usage:
 *   <Banner variant="warn" title="Debrief needed">
 *     This deal closed without a Win/Loss debrief. Two minutes now feeds
 *     the quarterly review.
 *     <Banner.Cta href="?tab=debrief">Add debrief</Banner.Cta>
 *   </Banner>
 *
 * The CTA is optional — omit if the banner is purely informational.
 * Multiple CTAs are supported by rendering multiple <Banner.Cta> children;
 * the last one gets the primary tone, others get outlined-secondary tone.
 */

import Link from "next/link";
import type { ReactNode } from "react";

export type BannerVariant = "info" | "warn" | "success" | "danger";

const VARIANT_STYLES: Record<
  BannerVariant,
  {
    stripe: string;
    tint: string;
    iconWrap: string;
    iconColor: string;
    text: string;
  }
> = {
  info: {
    stripe: "bg-cc-brand-500",
    tint: "bg-gradient-to-br from-white to-blue-50/40",
    iconWrap: "bg-cc-brand-100",
    iconColor: "text-cc-brand-700",
    text: "text-ppp-charcoal",
  },
  warn: {
    stripe: "bg-amber-500",
    tint: "bg-gradient-to-br from-white to-amber-50/50",
    iconWrap: "bg-amber-100",
    iconColor: "text-amber-700",
    text: "text-ppp-charcoal",
  },
  success: {
    stripe: "bg-emerald-500",
    tint: "bg-gradient-to-br from-white to-emerald-50/40",
    iconWrap: "bg-emerald-100",
    iconColor: "text-emerald-700",
    text: "text-ppp-charcoal",
  },
  danger: {
    stripe: "bg-rose-500",
    tint: "bg-gradient-to-br from-white to-rose-50/40",
    iconWrap: "bg-rose-100",
    iconColor: "text-rose-700",
    text: "text-ppp-charcoal",
  },
};

function DefaultIcon({ variant }: { variant: BannerVariant }) {
  const paths: Record<BannerVariant, ReactNode> = {
    info: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </>
    ),
    warn: (
      <>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    success: (
      <>
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <path d="M22 4L12 14.01l-3-3" />
      </>
    ),
    danger: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M15 9l-6 6M9 9l6 6" />
      </>
    ),
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[variant]}
    </svg>
  );
}

export function Banner({
  variant,
  title,
  icon,
  children,
  className,
}: {
  variant: BannerVariant;
  title?: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const s = VARIANT_STYLES[variant];
  return (
    <div
      role="status"
      className={`relative overflow-hidden rounded-xl border border-ppp-charcoal-100 shadow-sm ${s.tint} ${className ?? ""}`}
    >
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${s.stripe}`} />
      <div className="pl-4 pr-4 py-3.5 flex items-start gap-3 flex-wrap sm:flex-nowrap">
        <span
          aria-hidden
          className={`shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg ${s.iconWrap} ${s.iconColor}`}
        >
          {icon ?? <DefaultIcon variant={variant} />}
        </span>
        <div className={`min-w-0 flex-1 ${s.text}`}>
          {title && (
            <div className="text-[13.5px] font-semibold leading-snug">
              {title}
            </div>
          )}
          <div className="text-[13px] text-ppp-charcoal-600 leading-relaxed mt-0.5 [&_a]:text-cc-brand-700 [&_a]:hover:text-cc-brand-700 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:text-ppp-charcoal">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** CTA link rendered inside a Banner. Primary tone. Wraps to a new
 *  row on mobile via flex-wrap on the parent. */
export function BannerCta({
  href,
  children,
  tone = "primary",
}: {
  href: string;
  children: ReactNode;
  tone?: "primary" | "ghost";
}) {
  const cls =
    tone === "primary"
      ? "inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-semibold hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/30 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40 no-underline"
      : "inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 hover:bg-cc-brand-50 min-h-[36px] touch-manipulation no-underline";
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** Actions row for a Banner. Right-aligns CTAs on desktop, stacks below
 *  the copy on mobile. Use inside <Banner> after the description. */
export function BannerActions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap sm:justify-start">
      {children}
    </div>
  );
}
