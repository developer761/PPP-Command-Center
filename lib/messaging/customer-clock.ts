/**
 * WHOSE CLOCK DECIDES WHETHER WE MAY TEXT SOMEBODY.
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * The gate resolved sending hours against `ws.time_zone` — the WORKSPACE's
 * clock. At 9:30 AM Eastern a New York workspace was allowed to text a
 * California customer, where it was 6:30 in the morning.
 *
 * TCPA's floor is 8 AM in the RECIPIENT's local time, not the sender's. So
 * that is not only A36's per-customer window missing, it is a send that
 * should never have been permitted.
 *
 * Kate's spec says the same thing about A36 and says why it is easy to get
 * wrong: "In hours is per customer, not per clock... Resolve against the
 * recipient's own callable window, never against one global 'are we open'
 * flag — a single flag gets two of the six states wrong every evening."
 *
 * ── HOW THE ZONE IS RESOLVED, AND WHAT HAPPENS WHEN IT CANNOT BE ────────
 *
 *   1. the zip on the conversation, through PPP's own curated territory
 *      table, which is the most authoritative thing we hold
 *   2. the phone's area code
 *   3. neither — and then the MOST RESTRICTIVE window of the areas PPP
 *      serves, never the workspace's own
 *
 * Step 3 is the whole point. Falling back to the sender's clock is what
 * produced the 6:30 AM send. Being an hour late costs nothing; being three
 * hours early is the violation. Today 0 of 10 conversations carry a zip, so
 * step 2 is what will actually run, and step 3 is not hypothetical.
 */

/** IANA zone per state. */
const ZONE_BY_STATE: Record<string, string> = {
  // Eastern
  CT: "America/New_York", DC: "America/New_York", DE: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", MA: "America/New_York",
  MD: "America/New_York", ME: "America/New_York", MI: "America/New_York",
  NC: "America/New_York", NH: "America/New_York", NJ: "America/New_York",
  NY: "America/New_York", OH: "America/New_York", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", VA: "America/New_York",
  VT: "America/New_York", WV: "America/New_York",
  // Central
  AL: "America/Chicago", AR: "America/Chicago", IA: "America/Chicago",
  IL: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", MN: "America/Chicago", MO: "America/Chicago",
  MS: "America/Chicago", ND: "America/Chicago", NE: "America/Chicago",
  OK: "America/Chicago", SD: "America/Chicago", TN: "America/Chicago",
  TX: "America/Chicago", WI: "America/Chicago",
  // Mountain
  AZ: "America/Phoenix", CO: "America/Denver", ID: "America/Denver",
  MT: "America/Denver", NM: "America/Denver", UT: "America/Denver",
  WY: "America/Denver",
  // Pacific and beyond
  CA: "America/Los_Angeles", NV: "America/Los_Angeles",
  OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  AK: "America/Anchorage", HI: "Pacific/Honolulu",
};

/**
 * Area code to state, for the eleven states PPP's territory table covers
 * plus the rest of the country where it is unambiguous.
 *
 * KNOWN IMPRECISION, stated rather than hidden: a few states straddle a
 * boundary. 915 is El Paso and runs on Mountain time while the rest of Texas
 * is Central; 850 covers a Florida panhandle that is partly Central. Both
 * resolve to their state's majority zone here, which can be an hour out.
 *
 * That error is bounded and lands on the safe side of the federal floor in
 * the Texas case (Central is EARLIER than Mountain, so we wait longer) and
 * the unsafe side for the Florida panhandle by one hour. Worth a zip.
 *
 * A ported number keeps its old area code, so this is a good guess and not a
 * fact. The zip beats it whenever we have one.
 */
const STATE_BY_AREA_CODE: Record<string, string> = {};
const addCodes = (state: string, codes: string) => {
  for (const c of codes.split(/\s+/).filter(Boolean)) STATE_BY_AREA_CODE[c] = state;
};
addCodes("NY", "212 315 329 332 347 363 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934");
addCodes("NJ", "201 551 609 640 732 848 856 862 908 973");
addCodes("CT", "203 475 860 959");
addCodes("FL", "239 305 321 324 352 386 407 448 561 645 656 689 727 754 772 786 813 850 863 904 941 954");
addCodes("CA", "209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 837 840 858 909 916 925 949 951");
addCodes("CO", "303 719 720 970 983");
addCodes("TX", "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979");
addCodes("LA", "225 318 337 504 985");
addCodes("MD", "227 240 301 410 443 667");
addCodes("NC", "252 336 472 704 743 828 910 919 980 984");
addCodes("VA", "276 434 540 571 703 757 804 826 948");

/**
 * THE MOST RESTRICTIVE ZONE PPP SERVES.
 *
 * Used when neither the zip nor the area code says anything. Pacific wakes
 * last, so holding a message to 8 AM Pacific cannot be early for anybody in
 * the territory. It CAN be late for an Eastern customer, which is the
 * direction to be wrong in.
 */
export const FALLBACK_ZONE = "America/Los_Angeles";

export type ZoneSource = "zip" | "area_code" | "fallback";
export type ResolvedZone = { timeZone: string; source: ZoneSource; state: string | null };

/** The state an area code sits in, or null when it is not one we map. */
export function stateForAreaCode(phoneE164: string | null | undefined): string | null {
  const digits = (phoneE164 ?? "").replace(/\D/g, "");
  // +1AAANXXXXXX — the area code is the three digits after the country code.
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return STATE_BY_AREA_CODE[national.slice(0, 3)] ?? null;
}

/** The IANA zone for a state code, or null when the state is unknown. */
export function zoneForState(state: string | null | undefined): string | null {
  if (!state) return null;
  return ZONE_BY_STATE[state.trim().toUpperCase()] ?? null;
}

/**
 * Which clock this customer lives on.
 *
 * `zipState` is the state their zip resolves to in PPP's own territory table
 * — the caller looks it up, because that is a database read and this stays
 * pure so it can be tested without one.
 */
export function customerZone(input: {
  zipState?: string | null;
  phone?: string | null;
}): ResolvedZone {
  const fromZip = zoneForState(input.zipState);
  if (fromZip) return { timeZone: fromZip, source: "zip", state: input.zipState!.toUpperCase() };

  const areaState = stateForAreaCode(input.phone);
  const fromArea = zoneForState(areaState);
  if (fromArea) return { timeZone: fromArea, source: "area_code", state: areaState };

  return { timeZone: FALLBACK_ZONE, source: "fallback", state: null };
}
