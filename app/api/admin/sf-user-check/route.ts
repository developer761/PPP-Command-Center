import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { crossDomainEmailVariant, normalizeEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";
import { pickBestUser, type SfUserCandidate } from "@/lib/auth/sf-user-lookup";

/**
 * Why can this person not sign in?  (Kate, 2026-08-31)
 *
 *   GET /api/admin/sf-user-check?email=amariani@precisionpaintingplus.net
 *
 * Shows every Salesforce user on BOTH PPP domains for an address, and which one
 * the hub would pick. Exists because the failure it diagnoses is invisible from
 * the outside: the person sees "your Salesforce user is inactive", and nothing
 * tells anyone that a DIFFERENT record — the live one, on the other domain —
 * was never consulted. Amy Mariani was locked out by exactly that.
 *
 * Read-only, admin-only.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const profile = await getProfileByUserId(data.user.id);
  if (!(profile?.is_admin ?? isAdminEmail(data.user.email))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const raw = new URL(request.url).searchParams.get("email") ?? "";
  const email = normalizeEmail(raw);
  if (!email) return NextResponse.json({ error: "missing_email" }, { status: 400 });

  const swapped = crossDomainEmailVariant(email);
  const addresses = swapped && swapped !== email ? [email, swapped] : [email];

  try {
    const conn = await getSalesforceClient();
    const found: SfUserCandidate[] = [];
    const perAddress: Record<string, unknown[]> = {};

    for (const addr of addresses) {
      if (!/^[a-z0-9._+\-]+@[a-z0-9.\-]+$/i.test(addr)) { perAddress[addr] = []; continue; }
      const safe = addr.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const r = await conn.query<{ Id: string; Name: string | null; Email: string | null; IsActive: boolean; CreatedDate: string }>(
        `SELECT Id, Name, Email, IsActive, CreatedDate FROM User WHERE Email = '${safe}' ORDER BY IsActive DESC, CreatedDate DESC LIMIT 5`
      );
      perAddress[addr] = r.records.map((u) => ({
        name: u.Name, email: u.Email, active: u.IsActive, created: u.CreatedDate?.slice(0, 10),
      }));
      for (const u of r.records) {
        found.push({
          id: u.Id, name: u.Name ?? "", email: u.Email ?? addr,
          isActive: u.IsActive, createdDate: u.CreatedDate ?? null,
        });
      }
    }

    const best = pickBestUser(found);
    const anyActive = found.some((u) => u.isActive);

    return NextResponse.json({
      ok: true,
      searched: addresses,
      foundPerAddress: perAddress,
      hubWouldPick: best,
      canSignIn: anyActive,
      verdict: anyActive
        ? `Signs in as "${best?.name}" (${best?.email}).`
        : found.length > 0
          ? "Blocked — records exist on these addresses but none are active. The sign-in page says exactly that."
          : "Blocked — no Salesforce user on either domain answers to this address.",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "sf_query_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
