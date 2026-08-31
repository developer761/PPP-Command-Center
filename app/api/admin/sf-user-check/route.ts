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
 *   GET /api/admin/sf-user-check?email=someone@precisionpaintingplus.net
 *   GET /api/admin/sf-user-check?name=Mariano
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

  const params = new URL(request.url).searchParams;
  const raw = params.get("email") ?? "";
  const nameQuery = (params.get("name") ?? "").trim();
  const email = normalizeEmail(raw);
  if (!email && !nameQuery) {
    return NextResponse.json({ error: "missing_email_or_name" }, { status: 400 });
  }

  const swapped = email ? crossDomainEmailVariant(email) : null;
  const addresses = email ? (swapped && swapped !== email ? [email, swapped] : [email]) : [];

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

    /**
     * WHICH ORG ARE WE EVEN ASKING?
     *
     * Everything above assumes the hub is querying the Salesforce that PPP
     * actually works in. If the connection points at a sandbox, every user
     * lookup is being answered by a copy that may never have had these people
     * in it — and the symptom is identical to a genuinely missing user, which
     * is exactly how an hour disappears. So the answer says where it came from.
     */
    type OrgRow = { Name: string | null; IsSandbox: boolean; InstanceName: string | null };
    let org: OrgRow | null = null;
    try {
      const r = await conn.query<OrgRow>("SELECT Name, IsSandbox, InstanceName FROM Organization LIMIT 1");
      org = (r.records[0] as OrgRow | undefined) ?? null;
    } catch {
      // Reading the org is diagnostics, never the answer — a failure here must
      // not take down the user lookup this endpoint exists for.
    }

    // Is this org populated at all? A count distinguishes "this person is
    // missing" from "everyone is missing".
    let activeUsers: number | null = null;
    try {
      const r = await conn.query<{ expr0?: number }>("SELECT COUNT(Id) FROM User WHERE IsActive = true");
      activeUsers = (r.records[0] as { expr0?: number } | undefined)?.expr0 ?? null;
    } catch {
      /* diagnostics only */
    }

    const best = pickBestUser(found);
    const anyActive = found.some((u) => u.isActive);

    /**
     * When no address matches, answer the question that actually follows.
     *
     * "No user on either domain" is a dead end — the next thing anyone needs is
     * "then what IS their address?", and going to look that up in Salesforce by
     * hand is the work this endpoint exists to save. So search by name and
     * return the real addresses.
     */
    let didYouMean: unknown[] | null = null;
    const term = nameQuery || (email ? email.split("@")[0] : "");
    if (found.length === 0 && term) {
      // Same injection guard as the email path: letters, digits, spaces,
      // apostrophes and hyphens only — enough for a person's name.
      const safeName = term.replace(/[^a-z0-9 '\-]/gi, "");
      if (safeName.length >= 2) {
        // Match the NAME or the ADDRESS: a person whose SF name is spelled
        // differently from what anyone remembers is still findable by the local
        // part of the email they actually sign in with, and vice versa.
        const esc = safeName.replace(/'/g, "\\'");
        const r = await conn.query<{ Name: string | null; Email: string | null; IsActive: boolean }>(
          `SELECT Name, Email, IsActive FROM User WHERE Name LIKE '%${esc}%' OR Email LIKE '%${esc}%' ORDER BY IsActive DESC LIMIT 15`
        );
        didYouMean = r.records.map((u) => ({ name: u.Name, email: u.Email, active: u.IsActive }));
      }
    }

    return NextResponse.json({
      ok: true,
      org: org
        ? { name: org.Name, isSandbox: org.IsSandbox, instance: org.InstanceName,
            note: org.IsSandbox
              ? "SANDBOX — this is not the Salesforce PPP works in. Users missing here may exist in production."
              : "Production." }
        : { note: "Could not read the Organization record." },
      activeUsersInOrg: activeUsers,
      searched: addresses,
      foundPerAddress: perAddress,
      hubWouldPick: best,
      canSignIn: anyActive,
      didYouMean,
      // Plain hyphens: this output gets pasted into terminals and chat, where a
      // stray em dash arrives as mojibake and looks like corrupted data.
      verdict: anyActive
        ? `Signs in as "${best?.name}" (${best?.email}).`
        : found.length > 0
          ? "Blocked - records exist on these addresses but none are active. The sign-in page says exactly that."
          : didYouMean && didYouMean.length > 0
            ? "No user answers to that address. See didYouMean for the real ones."
            : "No Salesforce user matches that address or name.",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "sf_query_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
