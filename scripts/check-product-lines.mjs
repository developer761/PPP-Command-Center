#!/usr/bin/env node
/**
 * DID THE LAST REAL ORDER RECORD ITS PAINT LINES?
 *
 *   npm run check:product-lines
 *
 * READ ONLY. Writes nothing, sends nothing.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * `WorkOrder.Product_Lines__c` records what was ORDERED, so it can be read
 * next to `MaterialType__c`, what was QUOTED. Until 2026-10-09 it had exactly
 * one writer: the product-line dropdown an AM picks on Internal Entry.
 *
 * Kate asked for that dropdown to be removed. Deleting it would have stopped
 * the writeback dead and said nothing — the same way MaterialType__c writes
 * failed silently from July until her R6.2 work found them. So the write
 * moved to where the real answer lives: the per-color picks, at the moment
 * the order is sent.
 *
 * That new path cannot be exercised without emailing a live vendor, so the
 * old dropdown stays until one genuine order has gone out and the field is
 * seen landing. This is that check.
 *
 * ── READING IT ──────────────────────────────────────────────────────────
 *
 *   ✓  an order sent after the cutover, and its WO carries Product_Lines__c
 *      → the new writer works. Remove the Internal Entry selector.
 *
 *   ✗  an order sent after the cutover and the field is EMPTY
 *      → the new writer did not fire. Do NOT remove the selector; the
 *        send route logs the reason with "[supplier-order/send]".
 *
 *   –  no orders sent since the cutover yet
 *      → nothing to judge. Run it again after the next one.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

/** When the send-time writer went live (commit c5451e53). */
const CUTOVER = "2026-10-09T00:00:00Z";

const { createClient } = await import("@supabase/supabase-js");
const { getSalesforceClient } = await import("@/lib/salesforce/client");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const { data: orders, error } = await sb
  .from("supplier_orders")
  .select("id, work_order_id, po_number, supplier_name, sent_at")
  .not("sent_at", "is", null)
  .gte("sent_at", CUTOVER)
  .order("sent_at", { ascending: false })
  .limit(10);

if (error) {
  console.error("Could not read supplier_orders:", error.message);
  process.exit(1);
}

if (!orders?.length) {
  console.log(`\n  –  No supplier orders sent since the cutover (${CUTOVER.slice(0, 10)}).`);
  console.log(`     Nothing to judge yet. The next real order answers this.\n`);
  console.log(`     Until then the Internal Entry product-line selector STAYS —`);
  console.log(`     it is still the only writer that has been seen working.\n`);
  process.exit(0);
}

const conn = await getSalesforceClient();
const ids = [...new Set(orders.map((o) => o.work_order_id).filter(Boolean))];
const { records } = await conn.query(
  `SELECT Id, WorkOrderNumber, Product_Lines__c, MaterialType__c FROM WorkOrder
   WHERE Id IN (${ids.map((i) => `'${String(i).replace(/'/g, "")}'`).join(", ")})`
);
const byId = new Map(records.map((r) => [r.Id, r]));

console.log(`\n  Orders sent since ${CUTOVER.slice(0, 10)}: ${orders.length}\n`);
let landed = 0;
let blank = 0;
for (const o of orders) {
  const wo = byId.get(o.work_order_id);
  const lines = (wo?.Product_Lines__c ?? "").trim();
  const mark = lines ? "✓" : "✗";
  if (lines) landed++;
  else blank++;
  console.log(`  ${mark}  PO ${o.po_number ?? "—"}  ${String(o.supplier_name ?? "").slice(0, 22).padEnd(22)} WO ${wo?.WorkOrderNumber ?? o.work_order_id}`);
  console.log(`      ORDERED : ${lines || "(empty — the new writer did not land)"}`);
  console.log(`      QUOTED  : ${(wo?.MaterialType__c ?? "").trim() || "(none on the quote)"}`);
  console.log("");
}

console.log(`  ${landed} landed, ${blank} empty.\n`);
if (landed > 0 && blank === 0) {
  console.log(`  ✓  The send-time writer works. The Internal Entry product-line`);
  console.log(`     selector can be removed (Kate 2026-10-09), along with the old`);
  console.log(`     Product_Lines__c write in the customer-form submit route.\n`);
} else if (blank > 0) {
  console.log(`  ✗  At least one order did not record its lines. Do NOT remove the`);
  console.log(`     selector. Check the deploy logs for "[supplier-order/send]" —`);
  console.log(`     the write is soft and logs its reason rather than failing the`);
  console.log(`     send, so the order itself went out fine.\n`);
}
process.exit(0);
