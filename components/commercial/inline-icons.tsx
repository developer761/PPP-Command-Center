/**
 * Shared inline SVG icon set for the Commercial CC.
 *
 * Karan 2026-07-21 (design-system pass): the platform's standing rule is
 * "SVG icons everywhere, no Unicode emoji" — emoji render inconsistently
 * across OS/browser and read as unprofessional on a B2B contractor tool.
 * This module replaces the last scattered pictographic emoji (🌐 📍 💰 🔥
 * 💡 ⏰ 📄 🏢 🎯 🧾 🎉) with one consistent stroke-based icon language.
 *
 * All icons: 1em-scalable, inherit `currentColor`, `aria-hidden` by
 * default (decorative). Pass `size` to override the 14px default.
 */
import type { SVGProps } from "react";

type IconProps = { size?: number; className?: string } & Omit<
  SVGProps<SVGSVGElement>,
  "width" | "height"
>;

function base({ size = 14, className, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className,
    ...rest,
  };
}

export function IconGlobe(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function IconMapPin(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function IconDollar(p: IconProps) {
  return (
    <svg {...base(p)}>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

export function IconFlame(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

export function IconBulb(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 18h6 M10 22h4 M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1v.2h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </svg>
  );
}

export function IconClock(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function IconFileDoc(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}

export function IconBuilding(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 22v-4h6v4 M8 6h.01 M12 6h.01 M16 6h.01 M8 10h.01 M12 10h.01 M16 10h.01 M8 14h.01 M12 14h.01 M16 14h.01" />
    </svg>
  );
}

export function IconTarget(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

export function IconReceipt(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" />
      <path d="M8 7h8 M8 11h8 M8 15h5" />
    </svg>
  );
}

export function IconTrophy(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 21h8 M12 17v4 M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 4H4v2a3 3 0 0 0 3 3 M17 4h3v2a3 3 0 0 1-3 3" />
    </svg>
  );
}

/** Filled star — key-relationship / primary / current markers. Uses
 *  fill=currentColor (override the stroke default) for a solid glyph. */
export function IconStar({ size = 14, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden
      className={className}
      {...rest}
    >
      <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z" />
    </svg>
  );
}

export function IconAlertTriangle(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
