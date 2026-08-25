import "server-only";

import { distributeHouseSqft, DISTRIBUTABLE_SHARE } from "@/lib/measure/geometry";
import type { MeasureSuggestion } from "@/lib/measure/types";
import { firstConfiguredProvider } from "@/lib/measure/property-providers";

/**
 * Whole-house square footage from property records, split across the rooms on
 * a work order.
 *
 * This is the ZERO-EFFORT path, and that is its whole value: it needs nothing
 * from the crew and can run the moment a work order exists. On a business where
 * 77% of open jobs have no measurement at all, a rough number that arrives by
 * itself beats an accurate one nobody enters.
 *
 * WHAT IT CANNOT DO: property records give ONE number for the building. They
 * never give room dimensions. So this produces a distribution, not a
 * measurement, and it is deliberately reported as low confidence everywhere.
 *
 * A NOTE ON ZILLOW, since it is the name everyone reaches for: Zillow's public
 * API was retired, and what remains (Bridge Interactive) needs MLS agreements
 * PPP would have to qualify for. The realistic providers are ATTOM, Estated,
 * Rentcast, or county assessor data — all of which return building sqft, beds
 * and baths from an address.
 *
 * The provider sits behind this interface so swapping one for another is a
 * single file, and so the demo runs before any contract is signed.
 */

export type PropertyRecord = {
  buildingSqft: number;
  bedrooms?: number | null;
  bathrooms?: number | null;
  yearBuilt?: number | null;
  /** Which provider answered — shown to the user, and kept for auditing. */
  provider: string;
};

export interface PropertyLookupProvider {
  readonly name: string;
  readonly configured: boolean;
  lookup(address: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
  }): Promise<PropertyRecord | null>;
}

/**
 * Demo provider. Derives a plausible building size from the address so the
 * whole flow is exercisable end to end before a data contract exists — and
 * says so, loudly, everywhere the number surfaces.
 *
 * Deterministic on purpose: the same address gives the same answer every time,
 * so a demo can be walked through twice without the numbers moving.
 */
class DemoProvider implements PropertyLookupProvider {
  readonly name = "demo";
  readonly configured = true;
  async lookup(address: { street: string; postalCode: string }): Promise<PropertyRecord | null> {
    const seed = `${address.street}${address.postalCode}`.toLowerCase();
    if (!seed.trim()) return null;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    // Long Island housing stock: roughly 1,100–3,300 sqft.
    const buildingSqft = 1100 + (h % 2200);
    return {
      buildingSqft,
      bedrooms: 2 + (h % 4),
      bathrooms: 1 + (h % 3),
      yearBuilt: 1950 + (h % 70),
      provider: "demo",
    };
  }
}

/**
 * The live provider, or the demo one when no key is set.
 *
 * Resolved per call rather than cached so adding a key in Vercel takes effect
 * on the next request instead of on the next deploy.
 */
export function propertyProvider(): PropertyLookupProvider {
  return firstConfiguredProvider() ?? new DemoProvider();
}

/** True when no real provider is configured — the UI says so either way, so a
 *  demo number is never mistaken for a county record. */
export function usingDemoPropertyData(): boolean {
  return firstConfiguredProvider() === null;
}

export async function suggestFromAddress(input: {
  address: { street: string; city: string; state: string; postalCode: string };
  rooms: Array<{ id: string; label: string }>;
}): Promise<{ byRoom: Record<string, MeasureSuggestion>; property: PropertyRecord } | { error: string }> {
  const provider = propertyProvider();
  if (!provider.configured) return { error: "No property-data provider is configured." };
  if (!input.address.street?.trim()) return { error: "This work order has no street address on file." };

  const record = await provider.lookup(input.address);
  if (!record || record.buildingSqft <= 0) {
    return { error: "No property record found for that address." };
  }

  const distributed = distributeHouseSqft(record.buildingSqft, input.rooms);
  const byRoom: Record<string, MeasureSuggestion> = {};
  const pct = Math.round(DISTRIBUTABLE_SHARE * 100);
  for (const room of input.rooms) {
    const sqft = distributed[room.id];
    if (!sqft) continue;
    byRoom[room.id] = {
      source: "address",
      // Never anything but low. This is a share of a building, not a room.
      confidence: "low",
      sqft,
      rationale: `${record.buildingSqft.toLocaleString()} sq ft on record${
        record.provider === "demo" ? " (demo data)" : ""
      } — ${pct}% spread across ${input.rooms.length} rooms by type.`,
      detail: { ...record, distributableShare: DISTRIBUTABLE_SHARE },
    };
  }
  return { byRoom, property: record };
}
