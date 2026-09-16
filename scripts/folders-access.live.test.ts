/**
 * Report folders — the access rule against the REAL seeded rows.
 *
 * The unit tests use fixtures; this asks the live table what Mary, Kelvi and a
 * stranger will actually see once their logins exist, because a seed that put
 * the wrong report in the wrong folder would pass every fixture test.
 */
import { it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { computeReportAccess } from "@/lib/commercial/reports/access-rule";
import { REPORTS } from "@/lib/commercial/reports/registry";
import { createClient } from "@supabase/supabase-js";

const FINANCE = "6f1d3c2a-5b7e-4c1a-9d0e-000000000002";
const FIELD = "6f1d3c2a-5b7e-4c1a-9d0e-000000000003";

it("folder membership decides what a non-admin sees", async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  const { data: seeded } = await sb.from("commercial_report_folder_items").select("folder_id, report_key");
  const inFolder = (id: string) => (seeded ?? []).filter((r) => r.folder_id === id).map((r) => r.report_key).sort();

  const MARY = "00000000-0000-0000-0000-00000000fa11"; // stand-in id: nothing is written

  // loadAccessRows only fetches the folders a viewer BELONGS to, so a
  // membership injected after the fact would resolve against nothing. Build the
  // rows the way the loader would for a member, from the real tables.
  const { data: folderRows } = await sb.from("commercial_report_folders").select("id, owner_user_id, deleted_at");
  const rowsFor = (folderIds: string[], removedAt: string | null = null) => ({
    folders: (folderRows ?? []).filter((f) => folderIds.includes(f.id)),
    items: (seeded ?? []).filter((i) => folderIds.includes(i.folder_id)),
    memberships: folderIds.map((id) => ({ folder_id: id, user_id: MARY, removed_at: removedAt })),
  });

  // A stranger with no folders sees nothing.
  const none = await computeReportAccess({ userId: MARY, role: "rep" }, async () => rowsFor([]));
  expect(none.visible).toEqual([]);
  expect(none.lookupFailed).toBe(false);

  const mary = await computeReportAccess({ userId: MARY, role: "account_manager" }, async () => rowsFor([FINANCE]));
  const kelvi = await computeReportAccess({ userId: MARY, role: "rep" }, async () => rowsFor([FIELD]));
  const out = process.env.FOLDERS_OUT;
  if (out) appendFileSync(out, `Finance folder -> ${[...mary.visible].sort().join(", ")}\n`);
  if (out) appendFileSync(out, `Field Users    -> ${[...kelvi.visible].sort().join(", ")}\n`);
  expect([...mary.visible].sort()).toEqual(inFolder(FINANCE).filter((k) => k !== "estimator"));
  expect([...kelvi.visible].sort()).toEqual(inFolder(FIELD).filter((k) => k !== "estimator"));
  expect(mary.visible).not.toContain("estimator");

  // A removed member sees nothing again.
  const removed = await computeReportAccess({ userId: MARY, role: "rep" }, async () => rowsFor([FINANCE], new Date().toISOString()));
  expect(removed.visible).toEqual([]);

  // A failed lookup denies rather than guesses.
  const broken = await computeReportAccess({ userId: MARY, role: "rep" }, async () => { throw new Error("db down"); });
  expect(broken.visible).toEqual([]);
  expect(broken.lookupFailed).toBe(true);

  // An admin sees every registry report regardless of folders.
  const admin = await computeReportAccess({ userId: MARY, role: "admin" }, async () => rowsFor([]));
  expect(admin.visible.length).toBe(REPORTS.length);
});
