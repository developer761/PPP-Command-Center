/**
 * PPP brand constants — source of truth is the official Brand Guidelines deck
 * (PPP_Brand_Guide_Company_Deck-2023.pptx). All values below match the deck
 * exactly. Do not change without re-confirming with Karan.
 */
export const PPP_BRAND = {
  name: "Precision Painting Plus®",
  shortName: "PPP",
  tagline: "Professional Painting Company You Can Trust",
  established: 2007,

  contact: {
    phone: "888.392.8484",
    phoneTel: "+18883928484",
    website: "https://precisionpaintingplus.net",
  },

  social: {
    facebook: "https://www.facebook.com/precisionpaintingplus/",
    instagram: "https://www.instagram.com/precisionpaintingplus/",
    linkedin: "https://www.linkedin.com/company/precision-painting-plus/",
    houzz: "https://www.houzz.com/pro/precisionpaintingplusny/precision-painting-plus",
  },

  // Primary palette — three colors in the official logo
  colors: {
    orange: "#EE662E",
    blue: "#2BAAE1",
    green: "#8DC442",

    // Secondary palette — complements + supports the primary
    navy: "#172B4D",
    brown: "#48342D",
    teal: "#37738C",
    lightBlue: "#C4DDE4",
    paleGreen: "#E9F4D4",
    warmBeige: "#F0E8DD",

    // Neutrals
    charcoal: "#3F3E40",
    white: "#FFFFFF",
  },

  // Three brand values from the deck — surface in product copy where relevant.
  coreValues: [
    {
      title: "Honest Pricing",
      detail: "Honest pricing from the very beginning; we honor our estimations until day of completion.",
    },
    {
      title: "Premium Quality",
      detail: "Seasoned, skilled professionals using only high-quality, long-lasting materials.",
    },
    {
      title: "On-Time Completion",
      detail: "Flexible to client availability, adhere to the projected timeline.",
    },
  ],

  badges: [
    "Angi Super Service Award (2025)",
    "BBB Accredited Business",
    "HomeAdvisor Elite Service Award",
    "2-Year Warranty",
  ],
} as const;

export const APP_META = {
  name: "Command Center",
  version: "0.2.0",
  environment: "live",
} as const;
