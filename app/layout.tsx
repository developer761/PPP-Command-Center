import type { Metadata, Viewport } from "next";
import { Roboto, Roboto_Condensed } from "next/font/google";
import "./globals.css";

// Roboto + Roboto Condensed = PPP's official primary fonts (Brand Guidelines).
const roboto = Roboto({
  variable: "--font-roboto",
  weight: ["400", "500", "700", "900"],
  subsets: ["latin"],
  display: "swap",
});

const robotoCondensed = Roboto_Condensed({
  variable: "--font-roboto-condensed",
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "PPP Command Center",
  description:
    "Internal operations platform for Precision Painting Plus® — unified analytics, work order coordination, and team workflows.",
  icons: { icon: "/brand/logo.svg" },
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
  themeColor: "#1e3a8a",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${roboto.variable} ${robotoCondensed.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
