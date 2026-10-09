import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import ServiceWorkerRegister from "@/components/service-worker-register";
import InstallAppPrompt from "@/components/install-app-prompt";

/**
 * Roboto + Roboto Condensed = PPP's official primary fonts (Brand Guidelines).
 *
 * SELF-HOSTED, and that is the point. `next/font/google` downloads the font
 * at BUILD time, so every production build needed Vercel's builder to reach
 * fonts.gstatic.com. When it could not — a transient network failure on their
 * machine, nothing to do with this repo — Turbopack failed every generated
 * `roboto_*.module.css` import and the build died in about 20 seconds. That
 * happened at least four times, most recently 2026-10-07 on 13f2830.
 *
 * It mattered more than a flake: a merge to main here IS the release, and a
 * failed build leaves production silently on the old code while GitHub stays
 * green. A change that did not ship, with every signal saying it did.
 *
 * Reading from disk cannot fail that way. The files are the exact ones Google
 * served for the `latin` subset — variable fonts, one file per family across
 * the whole 100-900 axis, which is why there is no longer a weight list here:
 * `weight: "100 900"` declares the axis range and any weight in it renders.
 * Together they are ~84KB, and they are now also served from our own origin
 * instead of a third party.
 *
 * To refresh: fetch https://fonts.googleapis.com/css2?family=... with a modern
 * browser UA (Google serves woff2 only to browsers it recognizes), take the
 * url() from the `/* latin *\/` block, and replace the file.
 */
const roboto = localFont({
  src: "./fonts/roboto-latin-var.woff2",
  variable: "--font-roboto",
  weight: "100 900",
  display: "swap",
});

const robotoCondensed = localFont({
  src: "./fonts/roboto-condensed-latin-var.woff2",
  variable: "--font-roboto-condensed",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PPP Command Center",
  description:
    "Internal operations platform for Precision Painting Plus® — unified analytics, work order coordination, and team workflows.",
  // The wordmark stays the browser favicon; the square mark is what a phone
  // shows on a home screen. A 3.7:1 wordmark squashed into an app icon is
  // unreadable at 60px, which is the only size that matters there.
  icons: {
    icon: [
      { url: "/brand/logo.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
  /**
   * iOS ignores the manifest's `display` field. Installing to the home screen
   * only drops Safari's chrome if these are present, so without them "Add to
   * Home Screen" produces a bookmark that still opens in a browser.
   */
  appleWebApp: {
    capable: true,
    title: "PPP Hub",
    // "default" keeps the status bar legible over the navy chrome;
    // "black-translucent" would slide content under the notch.
    statusBarStyle: "default",
  },
  // Phone numbers on work orders are meant to be tappable, but iOS also
  // auto-links things that merely look like numbers — PO numbers, WO numbers,
  // square footages — and turns them blue mid-sentence. Explicit links only.
  formatDetection: { telephone: false },
};

/**
 * Viewport meta — CRITICAL for mobile. Without this, iOS Safari renders the
 * page at a desktop-equivalent ~980px wide and zooms the user out to fit,
 * shrinking every UI element to thumb-unfriendly sizes. The materials-page
 * workers + customer-form customers are mostly on phones — this was the
 * single biggest mobile bug on the platform (Round 4 mobile audit, 2026-06-05).
 *
 * `maximumScale: 1, userScalable: false` would prevent the user from
 * pinch-zooming — DON'T set those. Accessibility wants pinch-zoom available
 * for customers with low vision who need to read smaller copy.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // PPP navy. This was #1e3a8a — a stock Tailwind blue that appears nowhere in
  // the brand — which tinted the phone's status bar a color the product
  // doesn't use. Matches the manifest so the chrome is one color.
  themeColor: "#172B4D",
  // Installed apps run edge-to-edge; without this, content can sit under the
  // home indicator on a notched iPhone. Panes that pin controls to the bottom
  // pair this with env(safe-area-inset-bottom).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${roboto.variable} ${robotoCondensed.variable} h-full antialiased`}
    >
      <head>
        {/*
          Next emits the standardised `mobile-web-app-capable`, which iOS
          honours from 16.4. Older iPhones only recognise the apple-prefixed
          name, and without it "Add to Home Screen" produces a bookmark that
          still opens inside Safari — the browser bars stay, which is most of
          what installing was for. Crews carry old phones, so both ship.
        */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="min-h-full">
        {children}
        <ServiceWorkerRegister />
        <InstallAppPrompt />
      </body>
    </html>
  );
}
