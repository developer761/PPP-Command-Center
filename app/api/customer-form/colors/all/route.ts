import { NextResponse } from "next/server";
import { validateToken } from "@/lib/customer-form/tokens";
import { loadPaintCatalogOnly } from "@/lib/salesforce/queries";

/**
 * Full color palette dump for the customer form. Returns ALL ~5,762
 * PaintColor__c records in one response so the form can filter CLIENT-SIDE
 * (zero-latency typing) instead of round-tripping per keystroke.
 *
 * Why fetch-all instead of incremental search:
 *   - Customer typing speed is faster than network round-trip (slow customer
 *     = slow customer; we shouldn't add to their wait)
 *   - 5,762 records × ~100 bytes = ~570KB raw → ~70-90KB gzipped over the
 *     wire (one-time cost on form load)
 *   - In-memory client-side filter is O(n) but for 5762 items it's <5ms even
 *     on mid-range phones
 *   - Server response cached via HTTP for 1 hour — repeat opens of the form
 *     hit browser cache instantly
 *
 *   GET /api/customer-form/colors/all?token=<t>
 *
 * Token-gated like /colors/search. Returns:
 *   { ok: true, colors: ColorOption[], suppliers: Supplier[], generatedAt }
 *
 * Suppliers (Account references via PaintColor.manufacturerId) returned in
 * the same payload so the form can render the manufacturer filter chips
 * without a second fetch.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }
  const status = await validateToken(token);
  if (status.kind === "not_found" || status.kind === "expired") {
    return NextResponse.json({ error: status.kind }, { status: 403 });
  }

  // Fast path: load ONLY the paint catalog (5.7k rows, 24h-cached) instead of
  // the full SF snapshot (89k Opps + 88k WOs + accounts). This is what made the
  // customer form's cold load take 8-15s; now it's ~1-2s cold, instant warm.
  const catalog = await loadPaintCatalogOnly();

  const colors = catalog.colors.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    hex: c.hexValue,
    manufacturerId: c.manufacturerId,
    manufacturerName: c.manufacturerName,
  }));
  const suppliers = catalog.suppliers;

  return NextResponse.json(
    {
      ok: true,
      colors,
      suppliers,
      generatedAt: catalog.fetchedAt,
    },
    {
      headers: {
        // 1 hour browser cache, 1 hour CDN cache, stale-while-revalidate.
        // Color catalog is essentially static (Benjamin Moore doesn't add new
        // SKUs daily). If a customer re-opens the form within an hour, no
        // network roundtrip at all.
        "Cache-Control": "private, max-age=3600, stale-while-revalidate=3600",
      },
    }
  );
}
