import type { MetadataRoute } from "next";

/**
 * Installable-app manifest.
 *
 * The people this matters for are crews on a phone in someone's house: the
 * measure tool, the colour form, the work-order page. "Add to Home Screen"
 * turns those into a tap on an icon rather than a bookmark inside Safari, and
 * `display: standalone` drops the browser chrome — which is roughly 90px of
 * vertical space back on a small screen, on pages where the action lives at the
 * bottom.
 *
 * Deliberately NOT a route into everything. `start_url` opens the work-order
 * list rather than the analytics Overview, because someone opening this from a
 * home screen is standing on a job, and because an Account Manager has no
 * analytics access at all (R4.1) — landing them on a page that immediately
 * redirects is a poor first impression of an "app".
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PPP Command Center",
    short_name: "PPP Hub",
    description:
      "Precision Painting Plus operations — work orders, room measurement, colour selections and materials ordering.",
    start_url: "/dashboard/materials",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Navy chrome so the status bar blends into the app rather than banding.
    background_color: "#172B4D",
    theme_color: "#172B4D",
    categories: ["business", "productivity", "utilities"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Android crops icons to whatever shape the launcher uses; the maskable
      // variant carries a safe zone so the strokes never get clipped.
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Measure a room",
        short_name: "Measure",
        description: "Capture square footage for a work order",
        url: "/dashboard/measure",
        icons: [{ src: "/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Work orders",
        short_name: "Work orders",
        description: "Open jobs needing materials",
        url: "/dashboard/materials",
        icons: [{ src: "/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
