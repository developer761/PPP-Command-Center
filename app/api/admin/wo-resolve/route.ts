import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Resolve any WO identifier (human-readable WorkOrderNumber OR 15/18-char
 * Salesforce record Id) into the canonical 18-char Id used everywhere else
 * in the platform. Admin-only.
 *
 *   GET /api/admin/wo-resolve?q=00284666
 *   GET /api/admin/wo-resolve?q=0WOWj000005e9L3OAI
 *
 * Strategy:
 *   1. If the input matches SF's Id shape (15 or 18 alphanumeric), use it
 *      directly — return it as the canonical Id.
 *   2. Otherwise treat as a WorkOrderNumber: scan the snapshot for a
 *      matching `workOrderNumber`. If found, return its `id`.
 *   3. If still not found, do a live SF lookup by WorkOrderNumber as a
 *      last-resort (covers WOs older than the snapshot's 365-day window).
 *
 * Returns { ok, id, workOrderNumber, source } or { ok: false, error }.
 */

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(userData.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(userData.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const raw = new URL(request.url).searchParams.get("q");
  if (!raw) {
    return NextResponse.json({ error: "missing_q" }, { status: 400 });
  }
  const q = raw.trim();
  if (!q) {
    return NextResponse.json({ error: "empty_q" }, { status: 400 });
  }

  // Path 1 — looks like an SF Id already
  if (/^[a-zA-Z0-9]{15,18}$/.test(q)) {
    return NextResponse.json({ ok: true, id: q, workOrderNumber: null, source: "id_passthrough" });
  }

  // Path 2 — WO number lookup via snapshot. Tolerates leading zeros + whitespace.
  // PPP's WO numbers are typically 8 digits (e.g. "00284666").
  const numeric = q.replace(/\s+/g, "");
  if (!/^\d{1,15}$/.test(numeric)) {
    return NextResponse.json({
      ok: false,
      error: "unrecognized_format",
      message: `"${q}" doesn't look like an SF Id (15/18 alphanumeric) or a WO number (digits only). Check for typos.`,
    }, { status: 400 });
  }
  try {
    const snapshot = await loadSalesforceSnapshot();
    const hit = snapshot.workOrders.find((w) => w.workOrderNumber === numeric);
    if (hit) {
      return NextResponse.json({
        ok: true,
        id: hit.id,
        workOrderNumber: hit.workOrderNumber,
        accountName: hit.accountName,
        status: hit.status,
        source: "snapshot",
      });
    }
  } catch (err) {
    console.warn(`[wo-resolve] snapshot lookup failed:`, err instanceof Error ? err.message : err);
  }

  // Path 3 — live SF lookup as last resort (snapshot is 365-day windowed;
  // older WOs need a direct SOQL query).
  try {
    const conn = await getSalesforceClient();
    const result = await conn.query<{ Id: string; WorkOrderNumber: string }>(
      `SELECT Id, WorkOrderNumber FROM WorkOrder WHERE WorkOrderNumber = '${numeric}' LIMIT 1`
    );
    if (result.records.length > 0) {
      const wo = result.records[0];
      return NextResponse.json({
        ok: true,
        id: wo.Id,
        workOrderNumber: wo.WorkOrderNumber,
        source: "live_sf",
      });
    }
  } catch (err) {
    console.warn(`[wo-resolve] live SF lookup failed:`, err instanceof Error ? err.message : err);
  }

  return NextResponse.json({
    ok: false,
    error: "wo_not_found",
    message: `Couldn't find a WO with number "${numeric}". Double-check the number, or paste the 18-character SF record Id instead (starts with 0WO).`,
  }, { status: 404 });
}
