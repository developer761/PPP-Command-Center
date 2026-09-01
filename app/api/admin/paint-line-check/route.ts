import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";
import { PRODUCT_LINES_MAX } from "@/lib/customer-form/product-lines";


/**
 * Never cached. Admin surfaces read live database and Salesforce state, and a
 * cached response here is not a stale dashboard — it is a save that appears not
 * to have worked. Kate hit exactly that on Settings > Suppliers: unchecking
 * "Active" wrote correctly and the refresh handed back the pre-save list, so
 * the change looked lost when it was already in the database.
 */
export const dynamic = "force-dynamic";

/**
 * Proves the paint-line writeback can actually land.  (Kate R6.2)
 *
 *   GET /api/admin/paint-line-check
 *   GET /api/admin/paint-line-check?woId=<18-char WorkOrder id>
 *
 * WHY THIS EXISTS. The previous paint-line write targeted a restricted picklist
 * and was rejected on EVERY submit from at least 2026-07-14, silently — visible
 * only to anyone who thought to read sf_writes_audit. Nothing in the product
 * said a word. Moving to Product_Lines__c fixes the cause, but only if that
 * field is actually there, actually writable, and actually long enough. This
 * answers all three from the org itself rather than from an assumption.
 *
 * Read-only. It describes the field and optionally reads one work order's
 * current value; it never writes. Verifying a write by performing one would
 * mean putting test data on a real job.
 *
 * Admin-only.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const profile = await getProfileByUserId(data.user.id);
  if (!(profile?.is_admin ?? isAdminEmail(data.user.email))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const woId = (new URL(request.url).searchParams.get("woId") ?? "").trim().replace(/^['"]|['"]$/g, "");

  try {
    const conn = await getSalesforceClient();
    const described = await conn.sobject("WorkOrder").describe();
    const byName = new Map(described.fields.map((f) => [f.name, f]));

    const target = byName.get("Product_Lines__c");
    const estimator = byName.get("MaterialType__c");

    // Anything that looks like it might be the field under a different name —
    // the single most likely reason a write disappears.
    const nearMisses = described.fields
      .filter((f) => /product.?line/i.test(f.name) || /product.?line/i.test(f.label ?? ""))
      .map((f) => ({ name: f.name, label: f.label, type: f.type, length: f.length, updateable: f.updateable }));

    const problems: string[] = [];
    if (!target) problems.push("WorkOrder.Product_Lines__c does not exist in this org — every paint-line write will be rejected with INVALID_FIELD.");
    if (target && !target.updateable) problems.push("Product_Lines__c exists but is not updateable by this integration user — check field-level security on the connected app's profile.");
    if (target && typeof target.length === "number" && target.length < 60) {
      problems.push(`Product_Lines__c holds only ${target.length} characters; "Interior: … | Exterior: …" needs roughly 60. Longer values will be truncated before writing.`);
    }
    // The formatter truncates against a CONSTANT. Verified as 255 on 2026-08-27,
    // but a field converted to a Long Text Area, or shortened, would leave that
    // constant stale — over-long writes rejected with STRING_TOO_LONG, taking
    // the colours down with them since they share one batch. Compare, don't
    // just print both and leave a human to notice.
    if (target && typeof target.length === "number" && target.length !== PRODUCT_LINES_MAX) {
      problems.push(
        `The field holds ${target.length} characters but the formatter truncates at ${PRODUCT_LINES_MAX}. ` +
          (target.length < PRODUCT_LINES_MAX
            ? "Writes longer than the field will be REJECTED. Lower PRODUCT_LINES_MAX in lib/customer-form/product-lines.ts."
            : "Harmless today, but the formatter is cutting values shorter than it needs to. Raise PRODUCT_LINES_MAX to match.")
      );
    }
    // A picklist here would mean somebody converted it back, and every write
    // would start failing the way MaterialType__c did.
    if (target && target.type !== "string" && target.type !== "textarea") {
      problems.push(`Product_Lines__c is a ${target.type}, not free text. The hub writes plain line names and has no picklist vocabulary to satisfy.`);
    }
    if (!estimator) problems.push("WorkOrder.MaterialType__c is missing — the hub reads it to seed the AM's default, so the estimator's suggestion will not appear.");

    let sample: Record<string, unknown> | null = null;
    if (woId) {
      const q = await conn.query<Record<string, unknown>>(
        `SELECT Id, WorkOrderNumber, MaterialType__c, Product_Lines__c FROM WorkOrder WHERE Id = '${woId.replace(/'/g, "")}' LIMIT 1`
      );
      sample = q.records[0]
        ? {
            workOrder: q.records[0].WorkOrderNumber,
            estimatorPicked_MaterialType__c: q.records[0].MaterialType__c ?? null,
            hubOrdered_Product_Lines__c: q.records[0].Product_Lines__c ?? null,
          }
        : { error: `no work order found with id ${woId}` };
    }

    return NextResponse.json({
      ok: problems.length === 0,
      problems,
      writeTarget: target
        ? { name: target.name, label: target.label, type: target.type, length: target.length, updateable: target.updateable }
        : null,
      readOnlySource: estimator
        ? { name: estimator.name, type: estimator.type, updateable: estimator.updateable,
            note: "The hub READS this to seed the default and must never write it (R6.2)." }
        : null,
      formatterLimit: PRODUCT_LINES_MAX,
      nearMisses,
      sample,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "describe_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
