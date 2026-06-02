import type { NextConfig } from "next";

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
};

export default nextConfig;
