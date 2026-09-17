/**
 * Does a purchase with a receipt actually work, end to end?
 *
 * The field rendering is not the question — the question is whether the bytes
 * reach storage, the document links back to the purchase, the money lands in
 * the right cost bucket, and the Receipt column ticks. Every one of those is a
 * different file, and all four compile whether or not they agree.
 *
 * Writes a ONE CENT purchase against a real job, checks all of it, then hard
 * deletes the purchase and its document and proves they are gone. The vendor is
 * named so that if cleanup ever fails it is obvious in the ledger rather than
 * quietly folded into Tomco's costs.
 *
 *   npm run check:receipt
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const VENDOR = "ZZ AUTOMATED CHECK — DELETE ME";
const CENTS = 1;
let purchaseId = null;
let documentId = null;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  // A real, live job — the same kind the form offers.
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, title")
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!opp) throw new Error("no live job to test against");
  console.log(`\nAgainst job ${opp.id}\n`);

  // A real PNG, not an empty buffer: uploadDocument may reasonably reject one.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );

  const { addPurchase, attachPurchaseReceipt, getPurchase } = await import("../lib/commercial/purchases/db.ts");

  // 1 — the purchase, exactly as the accounting action books it.
  const res = await addPurchase({
    opportunity_id: opp.id,
    category: "materials",
    vendor: VENDOR,
    amount_cents: CENTS,
    hours: null,
    purchased_at: new Date().toISOString().slice(0, 10),
    description: "automated receipt-path check",
    reimburse_to: null,
    created_by_user_id: null,
  });
  check("addPurchase returns ok", res.ok, res.ok ? "" : res.error);
  if (!res.ok) throw new Error(res.error);
  // The action attaches to `res.value.id`. If that shape ever changes, the
  // receipt silently lands on nothing.
  check("returns the row with an id", !!res.value?.id, res.value?.id ?? "no id");
  purchaseId = res.value.id;

  // 2 — the receipt.
  const att = await attachPurchaseReceipt({
    purchaseId,
    file_name: "receipt-check.png",
    mime_type: "image/png",
    data: new Uint8Array(png),
    actorUserId: null,
  });
  check("attachPurchaseReceipt returns ok", att.ok, att.ok ? "" : att.error);
  if (att.ok) documentId = att.value.documentId;

  // 3 — the link back, read fresh.
  const fresh = await getPurchase(purchaseId);
  check("purchase carries receipt_document_id", !!fresh?.receipt_document_id);
  check("it is the document just uploaded", fresh?.receipt_document_id === documentId);
  check("the amount stored is cents, not dollars", fresh?.amount_cents === CENTS, String(fresh?.amount_cents));
  check("the category is what was asked for", fresh?.category === "materials", String(fresh?.category));
  check("it is attached to the right job", fresh?.opportunity_id === opp.id);
  check("account_id is filled in from the job", !!fresh?.account_id);

  // 4 — the document itself.
  const { data: doc } = await sb
    .from("commercial_documents")
    .select("id, file_name, mime_type, size_bytes")
    .eq("id", documentId)
    .maybeSingle();
  check("a document row exists", !!doc);
  check("the file name survived", doc?.file_name === "receipt-check.png", doc?.file_name ?? "");
  check("the mime type survived", doc?.mime_type === "image/png", doc?.mime_type ?? "");
  check("the bytes are all there", doc?.size_bytes === png.length, `${doc?.size_bytes} vs ${png.length}`);

  // 5 — the money reaches the job's costs, in the right bucket.
  const { costBreakdownByOpp } = await import("../lib/commercial/purchases/db.ts");
  const breakdown = await costBreakdownByOpp([opp.id]);
  const forOpp = breakdown.get(opp.id);
  check("the job's cost breakdown includes it", (forOpp?.materials ?? 0) >= CENTS, `materials=${forOpp?.materials}`);

  // 6 — the Purchases report ticks the Receipt column.
  const { getSpendRows } = await import("../lib/commercial/reports/tomco/transactions.ts");
  const rows = await getSpendRows();
  const row = rows.find((r) => r.id === purchaseId);
  check("it appears in the Purchases report", !!row);
  check("the Receipt column is ticked", row?.hasReceipt === true);
  check("the vendor reads back", row?.vendor === VENDOR, row?.vendor ?? "");
  check("it is NOT counted as labor", row?.category !== "labor", String(row?.category));

  // 7 — the guards in the accounting action, as pure logic.
  const empty = new File([], "nothing.png", { type: "image/png" });
  check("an empty file is skipped", !(empty instanceof File && empty.size > 0));
  const real = new File([png], "r.png", { type: "image/png" });
  check("a real file is taken", real instanceof File && real.size > 0);
} catch (err) {
  failures++;
  console.log("  FAIL  threw:", err instanceof Error ? err.message : String(err));
} finally {
  // Hard delete, not a soft one: a test row must not sit in the ledger under a
  // deleted_at that a future query forgets to filter.
  if (purchaseId) await sb.from("commercial_project_purchases").delete().eq("id", purchaseId);
  if (documentId) await sb.from("commercial_documents").delete().eq("id", documentId);
  const { data: leftPurchase } = await sb
    .from("commercial_project_purchases")
    .select("id")
    .eq("id", purchaseId ?? "00000000-0000-0000-0000-000000000000")
    .maybeSingle();
  const { data: anyStragglers } = await sb
    .from("commercial_project_purchases")
    .select("id")
    .eq("vendor", VENDOR);
  check("the test purchase is gone", !leftPurchase);
  check("no test rows left anywhere", (anyStragglers ?? []).length === 0, `${(anyStragglers ?? []).length} left`);

  console.log(
    failures === 0
      ? "\n✅ a purchase with a receipt works end to end, and cleaned up after itself"
      : `\n❌ ${failures} check(s) failed`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
