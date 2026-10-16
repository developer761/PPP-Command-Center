import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readSnapshotAge } from "@/lib/salesforce/queries";

/**
 * When the Salesforce data behind this page was actually pulled.
 *
 * Feeds the topbar's sync chip, which before 2026-10-16 showed the time the
 * React component mounted and called it "Live". See readSnapshotAge() for
 * what that hid.
 *
 * Signed-in users only (same bar as the refresh button it sits on), and
 * deliberately tiny: two timestamp columns, no payload. Anything heavier
 * here is a cost paid on every dashboard page load by every user, which is
 * exactly the trade that left the chip lying in the first place.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { fetchedAt } = await readSnapshotAge();
  return NextResponse.json(
    { fetchedAt },
    {
      headers: {
        // A minute of caching is free: the warm cron runs every 20, so the
        // answer cannot meaningfully change faster than that, and this keeps
        // a multi-tab admin from re-asking on every chrome mount.
        "Cache-Control": "private, max-age=60",
      },
    }
  );
}
