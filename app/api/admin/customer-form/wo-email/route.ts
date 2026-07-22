import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole } from "@/lib/auth/roles";
import { getSalesforceClient } from "@/lib/salesforce/client";
import { discoverEmailPaths, readPath } from "@/lib/customer-form/email-paths";

/**
 * Look up a work order's customer email DIRECTLY from Salesforce so the
 * "Send Color Form" modal can pre-fill it.
 *
 *   GET /api/admin/customer-form/wo-email?workOrderId=<id>
 *
 * SCHEMA-DRIVEN — describes WorkOrder + Account + Opportunity + Contact ONCE
 * at first call (cached 24h), finds every email-typed field on every object,
 * chases reference fields one level deep, and queries ALL discovered paths
 * in a single SOQL. Whichever path has a populated email wins.
 *
 * Replaces the prior hardcoded chain that kept missing PPP's actual location.
 *
 * Returns { ok:true, email, customerName, source } — email may be null.
 * Soft-fails (200 + email:null) on SF errors so the modal still lets the
 * worker type. Admin-only.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  // Admins + Account Managers can look up the customer email for a WO.
  // Deactivated accounts lose API access immediately (bootstrap admins exempt).
  if (profile && profile.is_active === false && !isAdminEmail(data.user.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(data.user.email));
  if (!capabilitiesFor(role).canEnterColors) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const workOrderId = new URL(request.url).searchParams.get("workOrderId");
  // SF ids are 15/18 alphanumeric — validate before interpolating into SOQL.
  if (!workOrderId || !/^[a-zA-Z0-9]{15,18}$/.test(workOrderId)) {
    return NextResponse.json({ error: "invalid_work_order_id" }, { status: 400 });
  }

  try {
    const conn = await getSalesforceClient();
    const { emailPaths, accountIdPaths, namePaths } = await discoverEmailPaths();

    // Build a single SOQL pulling every discovered path. If any field is FLS-
    // hidden the whole query errors — narrow progressively by dropping the
    // failing field until the query runs. We retry up to 10 times so a few
    // bad fields don't kill the lookup entirely.
    const allPaths = Array.from(new Set([...emailPaths, ...accountIdPaths, ...namePaths]));
    let usable = [...allPaths];
    let rec: Record<string, unknown> | null = null;
    let attempts = 0;
    while (usable.length > 0 && attempts < 10) {
      attempts++;
      try {
        const soql = `SELECT ${usable.join(", ")} FROM WorkOrder WHERE Id = '${workOrderId}' LIMIT 1`;
        const r = await conn.query<Record<string, unknown>>(soql);
        rec = r.records[0] ?? null;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Detect FLS / invalid-field errors and surgically remove the
        // offending field if SF named it. Otherwise bail.
        const fieldMatch = msg.match(/No such column '([^']+)'/) || msg.match(/INVALID_FIELD[^A-Z]+([A-Za-z0-9_.]+)/);
        if (fieldMatch) {
          const bad = fieldMatch[1];
          const before = usable.length;
          usable = usable.filter((p) => p !== bad && !p.endsWith(`.${bad}`) && !p.startsWith(`${bad}.`));
          if (usable.length === before) {
            // Couldn't find the bad field by exact match — try fuzzy.
            usable = usable.filter((p) => !p.toLowerCase().includes(bad.toLowerCase()));
          }
          if (usable.length === before) {
            console.warn(`[customer-form/wo-email] couldn't isolate failing field "${bad}" — abandoning lookup:`, msg);
            throw err;
          }
          console.warn(`[customer-form/wo-email] dropped FLS-blocked path "${bad}", retrying with ${usable.length} paths`);
        } else {
          // Non-field error — surface as soft-fail.
          throw err;
        }
      }
    }

    if (!rec) {
      console.log(`[customer-form/wo-email] WO=${workOrderId.slice(0, 6)}… record not found in SF`);
      return NextResponse.json({ ok: true, email: null, customerName: null, source: "(WO not found)" });
    }

    // Safety net: PPP's own staff email domains. Even after path-name
    // filtering ("Owner", "Salesperson", etc.) catches most staff-side
    // references, a customer-named field can still legitimately hold a
    // staff email (e.g., admin typed their own address into a customer
    // contact for testing). Refusing matches that resolve to a company
    // domain stops the modal from ever pre-filling with a rep email.
    // Override-able by COMPANY_EMAIL_DOMAINS env (comma-separated) when
    // PPP adds a domain.
    const COMPANY_EMAIL_DOMAINS = (process.env.COMPANY_EMAIL_DOMAINS ?? "precisionpaintingplus.com,precisionpaintingplus.net")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    const isCompanyEmail = (e: string): boolean => {
      const lower = e.toLowerCase();
      return COMPANY_EMAIL_DOMAINS.some((d) => lower.endsWith(`@${d}`));
    };

    // Walk every email path in order — first populated CUSTOMER email wins.
    // Staff-domain emails skipped so the modal never pre-fills with a PPP
    // rep's address (Katie 2026-06-03 — every WO was filling with the rep's
    // own email because PPP's schema has staff-email fields the discovery
    // was matching).
    let email: string | null = null;
    let source = "(none)";
    const staffMatches: string[] = []; // For diagnostic logging
    for (const path of emailPaths) {
      const v = readPath(rec, path);
      if (typeof v === "string" && v.trim() && v.includes("@")) {
        const candidate = v.trim();
        if (isCompanyEmail(candidate)) {
          staffMatches.push(`${path}=<staff-domain>`);
          continue; // Skip staff emails — keep looking for the actual customer
        }
        email = candidate;
        source = path;
        break;
      }
    }

    // Customer name from the first populated name path.
    let customerName: string | null = null;
    for (const path of namePaths) {
      const v = readPath(rec, path);
      if (typeof v === "string" && v.trim()) {
        customerName = v.trim();
        break;
      }
    }

    // Child-Contacts fallback: if no direct path had an email, fall back to
    // the most-recent Contact on the Account's Contacts related list. Covers
    // the case where the Account → Contact link is via the related list
    // rather than a direct lookup field.
    if (!email) {
      let accountId: string | null = null;
      for (const path of accountIdPaths) {
        const v = readPath(rec, path);
        if (typeof v === "string" && v.startsWith("001")) {
          accountId = v;
          break;
        }
      }
      if (accountId) {
        try {
          // Pull a few recent contacts (not just the latest) — we'll skip
          // any that are PPP staff and pick the first real customer one.
          const child = await conn.query<{ Email: string | null; Name: string | null }>(
            `SELECT Email, Name FROM Contact WHERE AccountId = '${accountId}' AND Email != null ORDER BY CreatedDate DESC LIMIT 10`
          );
          for (const c of child.records) {
            if (!c.Email || !c.Email.includes("@")) continue;
            if (isCompanyEmail(c.Email.trim())) {
              staffMatches.push(`Account.Contacts.<${c.Name ?? "?"}>=<staff-domain>`);
              continue;
            }
            email = c.Email.trim();
            source = `Account.Contacts (${c.Name ?? "most recent"})`;
            if (!customerName && c.Name) customerName = c.Name;
            break;
          }
        } catch (childErr) {
          console.warn(`[customer-form/wo-email] child-Contacts fallback failed:`, childErr instanceof Error ? childErr.message : childErr);
        }
      }
    }

    // Diagnostic — log the winning source AND any staff-domain matches we
    // skipped so we can see in Vercel logs whether PPP's schema needs more
    // staff-pattern blocklist entries. No PII logged — only field names.
    const skipNote = staffMatches.length > 0 ? ` (skipped staff: ${staffMatches.join(", ")})` : "";
    console.log(`[customer-form/wo-email] WO=${workOrderId.slice(0, 6)}… email source: ${source} ${email ? "(populated)" : "(EMPTY — no customer email anywhere)"}${skipNote}`);

    return NextResponse.json({ ok: true, email, customerName, source });
  } catch (err) {
    // Soft-fail — the modal still works, the worker just types the email.
    console.warn("[customer-form/wo-email] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: true, email: null });
  }
}
