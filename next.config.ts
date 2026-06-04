import type { NextConfig } from "next";

/**
 * Defensive security headers — applied to every response.
 *
 * - Strict-Transport-Security: forces HTTPS for 2 years incl. subdomains.
 *   Vercel terminates TLS so this only matters once a browser has visited
 *   us once, but it's free protection thereafter.
 * - X-Content-Type-Options: prevents MIME-type sniffing (an old IE bug
 *   class, but still recommended).
 * - X-Frame-Options: blocks the entire app from being iframed by any
 *   other origin (clickjacking defense). The customer color form is the
 *   only legitimate iframe target and even that lives at our own origin.
 * - Referrer-Policy: send only the origin (not the full path with
 *   sensitive query strings like ?token=) when navigating cross-origin.
 * - Permissions-Policy: disable APIs we don't use; reduces attack surface
 *   if a stray script ever lands on the page.
 *
 * NO Content-Security-Policy yet — Next.js with Turbopack inlines styles
 * and uses unsafe-inline for some hydration scripts; a strict CSP needs
 * per-request nonces (router-level work). Track that as follow-up; the
 * other 5 headers above are zero-risk and immediately useful.
 *
 * Round 4 audit (2026-06-04, agent a100cfd) flagged the missing headers.
 */
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  // Tree-shake unused exports from common packages so the client bundle only
  // ships what the app actually references. Most impactful on @supabase/*
  // (large package, many sub-modules — most pages only need a handful).
  experimental: {
    optimizePackageImports: [
      "@supabase/supabase-js",
      "@supabase/ssr",
    ],
  },
  async headers() {
    return [
      {
        // Apply to every route — exclusion list is small enough to ignore.
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
