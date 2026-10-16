import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logUpdate } from "@/lib/commercial/audit-log";

/**
 * Operating Company — the single configurable identity ("who we are") that
 * flows into every generated document. Replaces the hardcoded contractor
 * strings + PPP_BRAND/TOMCO_COMPANY_FOOTER constants (Phase 0, Karan 2026-08:
 * docs go out as Tomco). Singleton row (id = true).
 */
export type OperatingCompany = {
  name: string;
  legal_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  logo_asset_key: string | null;
  signature_asset_key: string | null;
  /** Who signs generated docs, and as what — Tomco's Form of Warranty names
   *  the signer ("Brendan Dwyer, VP"), not just the company. Null falls back
   *  to the old "Authorized signature" line. */
  signature_name: string | null;
  signature_title: string | null;
  /** R1d: emails allowed to approve proposals (in addition to any admin). */
  approver_emails: string[];
  /** RUX-6: emails pinged when a proposal is approved / sent back with changes. */
  receiver_emails: string[];
};

const COLS =
  "name, legal_name, address_line1, address_line2, city, state, zip, phone, fax, email, website, logo_asset_key, signature_asset_key, signature_name, signature_title, approver_emails, receiver_emails";

/** Fallback used when the migration hasn't been applied yet (graceful — every
 *  generator keeps working). Matches the seed row. */
const DEFAULTS: OperatingCompany = {
  name: "Tomco Painting",
  legal_name: "Tomco Painting",
  address_line1: "77 Windsor Place, Ste. 13",
  address_line2: null,
  city: "Central Islip",
  state: "NY",
  zip: "11722",
  phone: "631.582.2770",
  fax: "631.582.2771",
  email: null,
  website: "www.tomcopainting.com",
  logo_asset_key: null,
  signature_asset_key: null,
  // Katie's captured Form of Warranty signs "Brendan Dwyer, VP".
  signature_name: "Brendan Dwyer",
  signature_title: "VP",
  approver_emails: [],
  receiver_emails: [],
};

/** The one operating-company row (cheap singleton read; falls back to DEFAULTS
 *  if the table/row isn't there yet). Fetched fresh so settings edits show
 *  immediately — no cross-request cache to go stale. */
export async function getOperatingCompany(): Promise<OperatingCompany> {
  try {
    const sb = commercialDb();
    const { data } = await sb.from("commercial_operating_company").select(COLS).limit(1).maybeSingle();
    return (data as OperatingCompany) ?? DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/**
 * The company-wide retainage percentage, or null if none is configured.
 *
 * READ SEPARATELY, AND ON PURPOSE.
 *
 * The obvious move is to add `default_retainage_pct` to `COLS` above. That
 * would be a trap: migrations here are pasted into Supabase by hand, so there
 * is a window where the column does not exist, and PostgREST answers an
 * unknown column with an ERROR and a null `data` rather than throwing. The
 * singleton read would then quietly return DEFAULTS — wrong company address,
 * wrong signer, wrong phone — on every proposal, warranty and G702 the
 * platform generates, with nothing on screen to say why.
 *
 * So this is its own query. If the column is not there yet the answer is
 * "no company default", `pickRetainagePct` falls through to the job's own
 * previous certificate, and every other setting is untouched.
 */
export async function getDefaultRetainagePct(): Promise<number | null> {
  try {
    const sb = commercialDb();
    const { data, error } = await sb
      .from("commercial_operating_company")
      .select("default_retainage_pct")
      .limit(1)
      .maybeSingle();
    if (error) return null;
    const v = (data as { default_retainage_pct: number | null } | null)?.default_retainage_pct;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  } catch {
    return null;
  }
}

type Result = { ok: true } | { ok: false; error: string };

export async function updateOperatingCompany(
  patch: Partial<Omit<OperatingCompany, "logo_asset_key" | "signature_asset_key">> & {
    logo_asset_key?: string | null;
    signature_asset_key?: string | null;
    /** null clears it back to unset. Out-of-range is refused in words. */
    default_retainage_pct?: number | null;
  },
  actorUserId: string,
): Promise<Result> {
  const name = (patch.name ?? "").trim();
  if (patch.name != null && !name) return { ok: false, error: "Company name is required." };
  if (patch.default_retainage_pct != null) {
    const p = patch.default_retainage_pct;
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      return { ok: false, error: "Default retainage must be a percentage between 0 and 100." };
    }
  }
  const sb = commercialDb();
  const before = await getOperatingCompany();
  const clean = (v: string | null | undefined) => (v == null ? undefined : v.trim() || null);
  const row = {
    id: true,
    ...(patch.name != null ? { name } : {}),
    ...(patch.legal_name !== undefined ? { legal_name: clean(patch.legal_name) } : {}),
    ...(patch.address_line1 !== undefined ? { address_line1: clean(patch.address_line1) } : {}),
    ...(patch.address_line2 !== undefined ? { address_line2: clean(patch.address_line2) } : {}),
    ...(patch.city !== undefined ? { city: clean(patch.city) } : {}),
    ...(patch.state !== undefined ? { state: clean(patch.state) } : {}),
    ...(patch.zip !== undefined ? { zip: clean(patch.zip) } : {}),
    ...(patch.phone !== undefined ? { phone: clean(patch.phone) } : {}),
    ...(patch.fax !== undefined ? { fax: clean(patch.fax) } : {}),
    ...(patch.email !== undefined ? { email: clean(patch.email) } : {}),
    ...(patch.website !== undefined ? { website: clean(patch.website) } : {}),
    ...(patch.signature_name !== undefined ? { signature_name: clean(patch.signature_name) } : {}),
    ...(patch.signature_title !== undefined ? { signature_title: clean(patch.signature_title) } : {}),
    /*
     * Blank clears it back to "unset" rather than writing 0. A 0% default
     * would silently stop every first certificate withholding anything, which
     * is not what an empty box means — and `pickRetainagePct` reads null as
     * "nobody has chosen" and falls through. 0 remains typeable on an
     * individual certificate, where it IS meaningful.
     */
    ...(patch.default_retainage_pct !== undefined
      ? { default_retainage_pct: patch.default_retainage_pct }
      : {}),
    ...(patch.logo_asset_key !== undefined ? { logo_asset_key: patch.logo_asset_key } : {}),
    ...(patch.signature_asset_key !== undefined ? { signature_asset_key: patch.signature_asset_key } : {}),
    ...(patch.approver_emails !== undefined
      ? { approver_emails: Array.from(new Set(patch.approver_emails.map((e) => e.trim().toLowerCase()).filter(Boolean))) }
      : {}),
    ...(patch.receiver_emails !== undefined
      ? { receiver_emails: Array.from(new Set(patch.receiver_emails.map((e) => e.trim().toLowerCase()).filter(Boolean))) }
      : {}),
    updated_at: new Date().toISOString(),
    updated_by_user_id: actorUserId,
  };
  const { error } = await sb.from("commercial_operating_company").upsert(row, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_operating_company", "singleton", before, row, actorUserId);
  return { ok: true };
}

/** Address as display lines for a PDF letterhead / signature block. */
export function companyAddressLines(c: OperatingCompany): string[] {
  const lines: string[] = [];
  if (c.address_line1) lines.push(c.address_line1);
  if (c.address_line2) lines.push(c.address_line2);
  const cityStateZip = [c.city, c.state].filter(Boolean).join(", ");
  const csz = [cityStateZip, c.zip].filter(Boolean).join(" ").trim();
  if (csz) lines.push(csz);
  return lines;
}

/** One-line "Tel: … · Fax: … · Web: …" contact string for PDF footers. */
export function companyContactLine(c: OperatingCompany): string {
  return [
    c.phone ? `Tel: ${c.phone}` : null,
    c.fax ? `Fax: ${c.fax}` : null,
    c.website ? `Web: ${c.website}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
