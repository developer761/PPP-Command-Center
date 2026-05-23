import { NextResponse } from "next/server";
import { validateToken } from "@/lib/customer-form/tokens";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";

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

  const snapshot = await loadSalesforceSnapshot();

  // Strip the snapshot down to just the fields the form actually uses
  // (cuts payload by ~40%). Map manufacturerId → manufacturer name in one pass
  // so the client doesn't need to do account lookup.
  const accountNameById = new Map(snapshot.accounts.map((a) => [a.id, a.name]));
  const colors = snapshot.paintColors.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    hex: c.hexValue,
    manufacturerId: c.manufacturerId,
    manufacturerName: c.manufacturerId ? accountNameById.get(c.manufacturerId) ?? null : null,
  }));

  // Distinct list of suppliers actually present in the color catalog (most
  // are Benjamin Moore + Sherwin Williams; filter chips render these so the
  // customer can narrow scope).
  const supplierMap = new Map<string, string>();
  for (const c of colors) {
    if (c.manufacturerId && c.manufacturerName) {
      supplierMap.set(c.manufacturerId, c.manufacturerName);
    }
  }
  const suppliers = Array.from(supplierMap.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json(
    {
      ok: true,
      colors,
      suppliers,
      generatedAt: snapshot.fetchedAt,
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
