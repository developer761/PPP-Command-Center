/**
 * Salesforce vendor export → the vendor directory seed (Katie 2026-09-15).
 *
 * "Run a vendors report for Tomco jobs in SF since last year to make sure we
 * have all the vendors that they regularly use."
 *
 * The export (tomco_vendors_since_2025.csv) is every SF account that received
 * money on a Tomco job since 2025 — as a store, a labor payee, or a
 * reimbursement. It is NOT a clean vendor list, and loading it straight in would
 * put four fake vendors at the top of the picker a crew member taps on Thursday:
 *
 *   - CATCH-ALL PLACEHOLDERS. "Retail Vendor", "Gas Station", "Restaurants" and
 *     "Supermarket" are buckets SF bookkeeping drops unnamed receipts into.
 *     "Retail Vendor" alone holds $17k. Offering one in the picker invites every
 *     unfamiliar receipt into it and the vendor report learns nothing — so they
 *     are dropped, and listed.
 *
 *   - DUPLICATE ACCOUNTS. GTS Builders Supply exists three times, SP Sign
 *     Warehouse twice (a Prospect record created for a reimbursement, plus the
 *     real Retail Vendor record). Each becomes ONE vendor carrying every SF id.
 *
 *   - REIMBURSEMENT-ONLY PAYEES. People and companies Tomco paid BACK are not
 *     vendors Tomco buys from. Precision Painting Plus LLC is the parent company
 *     and TLA Contracting is inactive in SF — neither is seeded. A reimbursement
 *     record that is really a store we already have merges into that store.
 *
 * Pure — no I/O — so the rules above are tested (__tests__/commercial/
 * vendor-directory.test.ts) and the migration's seed block is generated from
 * the real export by scripts/build-commercial-vendor-seed.mjs rather than typed
 * by hand.
 */

import { VENDOR_KINDS, type VendorKind, type VendorStatus, vendorKey, formatVendorPhone } from "./constants";

/** Bookkeeping buckets, not vendors. Matched on {@link vendorKey}. */
export const SF_PLACEHOLDER_VENDOR_NAMES = ["Retail Vendor", "Gas Station", "Restaurants", "Supermarket"] as const;

/**
 * Reimbursement-only records we believe are a store already in the list, but
 * cannot prove from the export alone. The SF id is NOT merged (an unproven id
 * on the wrong vendor would mislead anyone reconciling back to SF) — the
 * evidence goes on the store's notes instead, and the row is reported.
 */
export const SF_PROBABLE_ALIASES: Record<string, { into: string; evidence: string }> = {
  art: {
    into: "Blick Art Materials",
    evidence: "same $26.70 amount, and created in the same 2025-09-10 batch as the GTS and SP Sign reimbursement duplicates",
  },
};

/**
 * SF spells a few names in lower case ("United rentals"). Corrected for display;
 * {@link vendorKey} is case-blind, so a purchase typed either way still matches.
 */
export const SF_DISPLAY_NAME_FIXES: Record<string, string> = {
  "United rentals": "United Rentals",
  "All Island Hardwood flooring": "All Island Hardwood Flooring",
  "Alpers True Value hardware": "Alpers True Value Hardware",
};

/**
 * Records that ARE seeded but need a human to confirm something the export
 * cannot answer. The note rides on the vendor so whoever opens it sees it.
 */
export const SF_REVIEW_NOTES: Record<string, string> = {
  "tomco labor":
    "Needs a check: SF's generic \"Tomco Labor\" payee names no individual. If it is a catch-all rather than a real payee, deactivate it so labor gets logged to the person.",
  "lc cristhian plaza":
    "Needs a check: SF lists a precisionpaintingplus.net email and a Westbury address for this sub — confirm they are the sub's own details.",
};

export type SeedVendor = {
  name: string;
  kind: VendorKind;
  status: VendorStatus;
  /** What they sell / do, from SF "Purchase Type" — the picker's hint line. */
  specialty: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payment_terms: string | null;
  preferred_payment: string | null;
  w9_on_file: boolean;
  compliance_status: string | null;
  notes: string | null;
  sf_account_ids: string[];
};

export type SeedDecision = {
  sfAccountId: string;
  sfName: string;
  category: string;
  totalSpend: string;
  decision: "seeded" | "merged" | "excluded";
  /** The vendor it became / merged into. */
  vendor: string | null;
  reason: string;
};

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsvRows(text: string): string[][] {
  const s = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Header-keyed objects. Throws on a ragged row — a shifted column would put a
 *  phone number in the zip field without a sound. */
export function csvToRecords(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsvRows(text);
  if (!header) return [];
  return body.map((r, i) => {
    if (r.length !== header.length) {
      throw new Error(`CSV row ${i + 2} has ${r.length} fields, header has ${header.length}`);
    }
    return Object.fromEntries(header.map((h, j) => [h.trim(), r[j]]));
  });
}

const clean = (v: string | undefined | null): string | null => {
  const s = (v ?? "").replace(/\s*\n\s*/g, ", ").replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};

const truthy = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";

/** SF sometimes has "NY 11782" typed into City. That is not a city. */
function cleanCity(city: string | undefined, zip: string | undefined): { city: string | null; zip: string | null } {
  const c = clean(city);
  const z = clean(zip);
  const m = c ? /^[A-Z]{2}\s*(\d{5})(?:-\d{4})?$/.exec(c) : null;
  if (m) return { city: null, zip: z ?? m[1] };
  return { city: c, zip: z };
}

/** A primary-contact cell that is really an account number ("Acct #917…"). */
const ACCOUNT_NOTE_RE = /^acct\b|^account\b/i;

function kindFor(category: string): VendorKind | null {
  const c = category.trim().toLowerCase();
  if (c === "retail") return "retail";
  if (c === "labor") return "labor";
  return null;
}

function spend(r: Record<string, string>): number {
  const n = Number(r.total_spend);
  return Number.isFinite(n) ? n : 0;
}

function vendorFromRow(r: Record<string, string>, kind: VendorKind): SeedVendor {
  const rawName = clean(r.name) ?? "";
  const name = SF_DISPLAY_NAME_FIXES[rawName] ?? rawName;
  const { city, zip } = cleanCity(r.city, r.zip);
  const contact = clean(r.primary_contact);
  const notes: string[] = [];
  let contactName = contact;
  if (contact && ACCOUNT_NOTE_RE.test(contact)) {
    notes.push(contact);
    contactName = null;
  }
  const legal = clean(r.legal_name);
  if (legal && vendorKey(legal) !== vendorKey(name)) notes.push(`Legal name: ${legal}`);
  const sub = clean(r.sub_agreement_signed);
  if (sub) notes.push(`Subcontractor agreement signed ${sub}`);
  if (truthy(r.direct_deposit)) notes.push("Direct deposit set up in SF");

  // A website on PPP's own domain is PPP's website, not the vendor's.
  let website = clean(r.website);
  if (website && /precisionpaintingplus\./i.test(website)) website = null;

  return {
    name,
    kind,
    status: (r.vendor_status ?? "").trim().toLowerCase() === "inactive" ? "inactive" : "active",
    specialty: clean(r.purchase_type) ?? clean(r.services_provided),
    contact_name: contactName,
    phone: formatVendorPhone(r.phone),
    email: clean(r.email)?.toLowerCase() ?? null,
    website,
    address_line1: clean(r.street),
    city,
    state: clean(r.state)?.toUpperCase() ?? null,
    zip,
    payment_terms: clean(r.payment_terms),
    preferred_payment: clean(r.preferred_payment),
    w9_on_file: truthy(r.w9),
    compliance_status: clean(r.compliance_status),
    notes: notes.length ? notes.join(" · ") : null,
    sf_account_ids: [clean(r.sf_account_id) ?? ""].filter(Boolean),
  };
}

/** Fill every blank on `into` from `from`; ids and notes accumulate. */
function mergeInto(into: SeedVendor, from: SeedVendor): void {
  const fields = [
    "specialty", "contact_name", "phone", "email", "website", "address_line1",
    "city", "state", "zip", "payment_terms", "preferred_payment", "compliance_status",
  ] as const;
  for (const f of fields) if (!into[f] && from[f]) into[f] = from[f];
  into.w9_on_file ||= from.w9_on_file;
  // Active if ANY record for it is: a blank status on one of three GTS records
  // must not deactivate the store the other two are actively used as.
  if (from.status === "active") into.status = "active";
  for (const id of from.sf_account_ids) if (!into.sf_account_ids.includes(id)) into.sf_account_ids.push(id);
  if (from.notes && !(into.notes ?? "").includes(from.notes)) {
    into.notes = into.notes ? `${into.notes} · ${from.notes}` : from.notes;
  }
}

function addNote(v: SeedVendor, note: string) {
  v.notes = v.notes ? `${v.notes} · ${note}` : note;
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function cleanSfVendorExport(rows: readonly Record<string, string>[]): {
  vendors: SeedVendor[];
  decisions: SeedDecision[];
} {
  const placeholderKeys = new Set(SF_PLACEHOLDER_VENDOR_NAMES.map(vendorKey));
  const decisions: SeedDecision[] = [];
  const byKey = new Map<string, SeedVendor>();
  const decide = (r: Record<string, string>, d: Omit<SeedDecision, "sfAccountId" | "sfName" | "category" | "totalSpend">) =>
    decisions.push({
      sfAccountId: r.sf_account_id ?? "",
      sfName: clean(r.name) ?? "",
      category: r.category ?? "",
      totalSpend: money(spend(r)),
      ...d,
    });

  // Real vendor records first, biggest spender first, so the record a
  // duplicate merges INTO is the one Tomco actually uses most.
  const vendorRows = rows.filter((r) => kindFor(r.category ?? "") !== null).sort((a, b) => spend(b) - spend(a));
  const otherRows = rows.filter((r) => kindFor(r.category ?? "") === null);

  for (const r of vendorRows) {
    const kind = kindFor(r.category)!;
    const key = vendorKey(clean(r.name) ?? "");
    if (!key) {
      decide(r, { decision: "excluded", vendor: null, reason: "No name on the SF record." });
      continue;
    }
    if (placeholderKeys.has(key)) {
      decide(r, {
        decision: "excluded",
        vendor: null,
        reason: `Catch-all placeholder, not a vendor — SF files unnamed receipts here (${Number(r.purchases_n) || 0} purchase${Number(r.purchases_n) === 1 ? "" : "s"}). Offering it in the picker would swallow every unfamiliar receipt.`,
      });
      continue;
    }
    const v = vendorFromRow(r, kind);
    if (SF_REVIEW_NOTES[key]) addNote(v, SF_REVIEW_NOTES[key]);
    const existing = byKey.get(key);
    if (existing) {
      if (existing.kind !== kind) {
        // Never silently change what a vendor IS. Keep the bigger record's kind.
        addNote(existing, `SF also lists this name as a ${kind} vendor (${r.sf_account_id})`);
      }
      mergeInto(existing, v);
      decide(r, { decision: "merged", vendor: existing.name, reason: `Duplicate SF account for the same ${existing.kind === "labor" ? "payee" : "store"} — merged; both SF ids kept.` });
      continue;
    }
    byKey.set(key, v);
    decide(r, {
      decision: "seeded",
      vendor: v.name,
      reason:
        kind === "labor"
          ? /^tomco labor\s*-/i.test(v.name)
            ? "Individual Tomco crew payee."
            : /^lc\b/i.test(v.name)
              ? "Labor company / sub."
              : "Labor payee."
          : "Store / supplier Tomco buys from.",
    });
  }

  for (const r of otherRows) {
    const name = clean(r.name) ?? "";
    const key = vendorKey(name);
    const match = byKey.get(key);
    if (match) {
      mergeInto(match, { ...vendorFromRow(r, match.kind), status: match.status, notes: null });
      decide(r, {
        decision: "merged",
        vendor: match.name,
        reason: `A ${r.category.toLowerCase()} record (SF type ${r.sf_type || "?"}) for a store already in the list — merged; its SF id kept.`,
      });
      continue;
    }
    const alias = SF_PROBABLE_ALIASES[key];
    const aliasTarget = alias ? byKey.get(vendorKey(alias.into)) : undefined;
    if (alias && aliasTarget) {
      addNote(aliasTarget, `SF "${name}" (${r.sf_account_id}) is probably this store — ${alias.evidence}`);
      decide(r, {
        decision: "excluded",
        vendor: aliasTarget.name,
        reason: `Reimbursement-only record that is probably ${aliasTarget.name} (${alias.evidence}). Noted on that vendor; SF id not merged because it is unproven.`,
      });
      continue;
    }
    const inactive = (r.vendor_status ?? "").trim().toLowerCase() === "inactive";
    const isPpp = /precision painting plus/i.test(name);
    decide(r, {
      decision: "excluded",
      vendor: null,
      reason: isPpp
        ? "Reimbursement payee that is PPP itself (the parent company) — not a vendor Tomco buys from."
        : `Reimbursement-only payee, not a store${inactive ? ", and inactive in SF" : ""} — Tomco paid them back, it didn't buy from them.`,
    });
  }

  const vendors = [...byKey.values()].sort(
    (a, b) => VENDOR_KINDS.indexOf(a.kind) - VENDOR_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
  return { vendors, decisions };
}

/** SQL literal. `null` → NULL; strings single-quote-escaped. */
function lit(v: string | null | boolean | string[]): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map((x) => lit(x)).join(", ")}]::text[]` : "'{}'::text[]";
  return `'${v.replace(/'/g, "''")}'`;
}

export const SEED_COLUMNS = [
  "name", "kind", "status", "specialty", "contact_name", "phone", "email", "website",
  "address_line1", "city", "state", "zip", "payment_terms", "preferred_payment",
  "w9_on_file", "compliance_status", "notes", "sf_account_ids",
] as const;

/** The VALUES rows of the idempotent seed INSERT, one vendor per line. */
export function vendorSeedValuesSql(vendors: readonly SeedVendor[]): string {
  return vendors
    .map((v) => `  (${SEED_COLUMNS.map((c) => lit(v[c])).join(", ")})`)
    .join(",\n");
}
