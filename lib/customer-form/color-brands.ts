/**
 * WHERE A CUSTOMER GOES TO LOOK AT COLORS.
 *
 * Kate FU.10 (2026-10-15): "On the section with the links for customers to
 * check colors, add a toggle for 'Brand'. Default brand should be Benjamin
 * Moore (as now) and then we have Sherwin Williams and Farrow & Ball."
 *
 * One list so the card renders from data instead of three hand-written
 * blocks that drift. Benjamin Moore stays first and is the default — it is
 * PPP's primary supplier and what every customer has seen until today.
 *
 * ── THE URLS ────────────────────────────────────────────────────────────
 *
 * Taken from her document. Two were wrapped across a line break by the PDF
 * and are rejoined here — "color-vis / ualizer" and "vin / yl-safe". Worth
 * saying out loud because a URL that is wrong by one character still looks
 * right in review and 404s for the customer.
 */

export type ColorBrand = {
  id: "benjamin-moore" | "sherwin-williams" | "farrow-ball";
  /** What the toggle shows. */
  label: string;
  /** One sentence under the heading, in the brand's own terms. */
  blurb: string;
  links: ReadonlyArray<{ label: string; href: string }>;
};

export const COLOR_BRANDS: ReadonlyArray<ColorBrand> = [
  {
    id: "benjamin-moore",
    label: "Benjamin Moore",
    blurb:
      "Browse Benjamin Moore's recommended palettes and their interactive room visualizer to see colors before you pick — or their exterior wood stains if your job includes decking, siding or fencing.",
    links: [
      { label: "Recommended palettes", href: "https://www.benjaminmoore.com/en-us/color-overview/color-palettes" },
      { label: "Visualize on a room", href: "https://www.benjaminmoore.com/en-us/color-overview/find-your-color/color-a-room" },
      { label: "Exterior stains", href: "https://www.benjaminmoore.com/en-us/b/woodluxe-exterior-wood-stain" },
    ],
  },
  {
    id: "sherwin-williams",
    label: "Sherwin Williams",
    blurb:
      "Browse Sherwin Williams' color collections and room visualizer, their exterior range, or their VinylSafe colors if you are painting vinyl siding.",
    links: [
      { label: "Color collections", href: "https://www.sherwin-williams.com/en-us/color/color-collections" },
      { label: "Room visualizer", href: "https://www.sherwin-williams.com/en-us/color/color-tools/color-visualizer/cvw/#/active" },
      { label: "Exterior colors", href: "https://www.sherwin-williams.com/en-us/color/exterior-paint-colors" },
      { label: "VinylSafe colors", href: "https://www.sherwin-williams.com/en-us/color/color-collections/vinyl-safe" },
    ],
  },
  {
    id: "farrow-ball",
    label: "Farrow & Ball",
    blurb:
      "Browse the full Farrow & Ball range, their room inspirations, or their exterior masonry colors.",
    links: [
      { label: "All paint colors", href: "https://www.farrow-ball.com/us/paint/all-paint-colours" },
      { label: "Room inspiration", href: "https://www.farrow-ball.com/us/room-inspiration" },
      { label: "Exterior colors", href: "https://www.farrow-ball.com/us/paint/exterior-masonry" },
    ],
  },
];

/** Benjamin Moore — PPP's primary supplier, and what the card showed before
 *  the toggle existed. Kate: "Default brand should be Benjamin Moore (as
 *  now)." */
export const DEFAULT_COLOR_BRAND = COLOR_BRANDS[0];
