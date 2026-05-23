import { NextResponse } from "next/server";
import { validateToken } from "@/lib/customer-form/tokens";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";

/**
 * Autocomplete endpoint for the customer color picker.
 *
 *   GET /api/customer-form/colors/search?token=<t>&q=<query>&manufacturer=<id>
 *
 * Token-gated (the customer's form session must be valid). Returns up to 30
 * matching PaintColor records sorted by relevance:
 *   1. Exact code match first (e.g. "2108-40" → BM Stardust)
 *   2. Then name prefix match
 *   3. Then name substring match
 *
 * Reads the cached snapshot's paintColors directory (5,762 records on prod
 * 2026-05-22). No SF round-trip per keystroke — the snapshot is in-memory.
 *
 * Manufacturer filter is optional — UI may default to Benjamin Moore but
 * lets the customer expand to other suppliers.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const manufacturer = url.searchParams.get("manufacturer");

  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }
  // Token must exist + not be expired. Submitted tokens still get search
  // access in case the customer is reviewing what they picked.
  const status = await validateToken(token);
  if (status.kind === "not_found" || status.kind === "expired") {
    return NextResponse.json({ error: status.kind }, { status: 403 });
  }

  if (q.length < 1) {
    // Empty query — return a small starter set (first 30 BM colors so the
    // picker isn't blank). Manufacturer filter still applied.
    const snapshot = await loadSalesforceSnapshot();
    const starter = snapshot.paintColors
      .filter((c) => (manufacturer ? c.manufacturerId === manufacturer : true))
      .slice(0, 30)
      .map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code,
        hex: c.hexValue,
        manufacturerId: c.manufacturerId,
      }));
    return NextResponse.json({ ok: true, query: q, results: starter });
  }

  const snapshot = await loadSalesforceSnapshot();
  const pool = manufacturer
    ? snapshot.paintColors.filter((c) => c.manufacturerId === manufacturer)
    : snapshot.paintColors;

  // Score each color: 3 = exact code match, 2 = name starts-with, 1 = name contains
  const scored: Array<{ score: number; idx: number; c: typeof pool[number] }> = [];
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i];
    const code = (c.code ?? "").toLowerCase();
    const name = (c.name ?? "").toLowerCase();
    const shortName = (c.shortName ?? "").toLowerCase();
    let score = 0;
    if (code === q) score = 100;                              // exact code wins
    else if (name.startsWith(q) || shortName.startsWith(q)) score = 50;
    else if (code.startsWith(q)) score = 30;
    else if (name.includes(q) || shortName.includes(q)) score = 10;
    else if (code.includes(q)) score = 5;
    if (score > 0) scored.push({ score, idx: i, c });
  }

  scored.sort((a, b) => (b.score - a.score) || a.c.name.localeCompare(b.c.name));
  const results = scored.slice(0, 30).map((r) => ({
    id: r.c.id,
    name: r.c.name,
    code: r.c.code,
    hex: r.c.hexValue,
    manufacturerId: r.c.manufacturerId,
  }));

  return NextResponse.json({ ok: true, query: q, results });
}
