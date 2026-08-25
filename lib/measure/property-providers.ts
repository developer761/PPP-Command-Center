import "server-only";

import type { PropertyLookupProvider, PropertyRecord } from "@/lib/measure/from-address";

/**
 * Real property-data providers.
 *
 * All three answer the same question — "what does the county think this
 * building is?" — and all three return total building square footage, never
 * per-room dimensions. That limit is the provider's, not ours, and it is why
 * an address lookup can only ever be a low-confidence starting point.
 *
 * ON ZILLOW, since it is always the first name suggested: the public API was
 * retired years ago. What remains is Bridge Interactive, which requires an MLS
 * agreement PPP would have to qualify for and does not sell assessor data as a
 * simple address lookup. These three do.
 *
 * Whichever key is present wins, in the order below. With none set the demo
 * provider runs and says so everywhere the number appears.
 */

type Address = { street: string; city: string; state: string; postalCode: string };

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Guard every provider call: a slow lookup must not hang a page. */
async function fetchJson(url: string, init: RequestInit, timeoutMs = 8000): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      console.warn(`[property] ${new URL(url).host} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn("[property] lookup failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* ─── ATTOM ─────────────────────────────────────────────────────────────────
 * The deepest assessor coverage of the three, and the one PPP most likely
 * wants for Long Island. Wants the address split into two lines.
 * Key: ATTOM_API_KEY — https://api.developer.attomdata.com
 */
class AttomProvider implements PropertyLookupProvider {
  readonly name = "ATTOM";
  get configured() { return !!process.env.ATTOM_API_KEY; }
  async lookup(a: Address): Promise<PropertyRecord | null> {
    const key = process.env.ATTOM_API_KEY;
    if (!key) return null;
    const url =
      "https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail" +
      `?address1=${encodeURIComponent(a.street)}` +
      `&address2=${encodeURIComponent(`${a.city}, ${a.state} ${a.postalCode}`.trim())}`;
    const json = (await fetchJson(url, { headers: { apikey: key, Accept: "application/json" } })) as
      { property?: Array<Record<string, never>> } | null;
    const p = json?.property?.[0] as Record<string, Record<string, unknown>> | undefined;
    if (!p) return null;
    // ATTOM reports several areas; universalsize is the living area figure.
    const size = p.building?.size as Record<string, unknown> | undefined;
    const rooms = p.building?.rooms as Record<string, unknown> | undefined;
    const buildingSqft = num(size?.universalsize) || num(size?.livingsize) || num(size?.bldgsize);
    if (!buildingSqft) return null;
    return {
      buildingSqft,
      bedrooms: num(rooms?.beds) || null,
      bathrooms: num(rooms?.bathstotal) || null,
      yearBuilt: num((p.summary as Record<string, unknown> | undefined)?.yearbuilt) || null,
      provider: this.name,
    };
  }
}

/* ─── Estated ───────────────────────────────────────────────────────────────
 * Simplest to integrate and cheapest to trial. Key: ESTATED_API_KEY
 */
class EstatedProvider implements PropertyLookupProvider {
  readonly name = "Estated";
  get configured() { return !!process.env.ESTATED_API_KEY; }
  async lookup(a: Address): Promise<PropertyRecord | null> {
    const key = process.env.ESTATED_API_KEY;
    if (!key) return null;
    const url =
      "https://apis.estated.com/v4/property" +
      `?token=${encodeURIComponent(key)}` +
      `&street_address=${encodeURIComponent(a.street)}` +
      `&city=${encodeURIComponent(a.city)}&state=${encodeURIComponent(a.state)}` +
      `&zip_code=${encodeURIComponent(a.postalCode)}`;
    const json = (await fetchJson(url, {})) as { data?: Record<string, Record<string, unknown>> } | null;
    const d = json?.data;
    if (!d) return null;
    const s = d.structure as Record<string, unknown> | undefined;
    const buildingSqft = num(s?.total_area_sq_ft) || num(s?.finished_area_sq_ft);
    if (!buildingSqft) return null;
    return {
      buildingSqft,
      bedrooms: num(s?.beds_count) || null,
      bathrooms: num(s?.baths) || null,
      yearBuilt: num(s?.year_built) || null,
      provider: this.name,
    };
  }
}

/* ─── Rentcast ──────────────────────────────────────────────────────────────
 * Good coverage, single-line address. Key: RENTCAST_API_KEY
 */
class RentcastProvider implements PropertyLookupProvider {
  readonly name = "Rentcast";
  get configured() { return !!process.env.RENTCAST_API_KEY; }
  async lookup(a: Address): Promise<PropertyRecord | null> {
    const key = process.env.RENTCAST_API_KEY;
    if (!key) return null;
    const full = `${a.street}, ${a.city}, ${a.state} ${a.postalCode}`.replace(/\s+/g, " ").trim();
    const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(full)}`;
    const json = (await fetchJson(url, { headers: { "X-Api-Key": key, Accept: "application/json" } })) as
      | Array<Record<string, unknown>>
      | Record<string, unknown>
      | null;
    const p = Array.isArray(json) ? json[0] : json;
    if (!p) return null;
    const buildingSqft = num(p.squareFootage);
    if (!buildingSqft) return null;
    return {
      buildingSqft,
      bedrooms: num(p.bedrooms) || null,
      bathrooms: num(p.bathrooms) || null,
      yearBuilt: num(p.yearBuilt) || null,
      provider: this.name,
    };
  }
}

export const REAL_PROVIDERS: PropertyLookupProvider[] = [
  new AttomProvider(),
  new EstatedProvider(),
  new RentcastProvider(),
];

/** The first provider with a key set, or null when none is configured. */
export function firstConfiguredProvider(): PropertyLookupProvider | null {
  return REAL_PROVIDERS.find((p) => p.configured) ?? null;
}

/** For Settings → Health: which are live, which are dark. */
export function providerStatus(): Array<{ name: string; configured: boolean; envVar: string }> {
  return [
    { name: "ATTOM", configured: !!process.env.ATTOM_API_KEY, envVar: "ATTOM_API_KEY" },
    { name: "Estated", configured: !!process.env.ESTATED_API_KEY, envVar: "ESTATED_API_KEY" },
    { name: "Rentcast", configured: !!process.env.RENTCAST_API_KEY, envVar: "RENTCAST_API_KEY" },
  ];
}
