import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  VENDOR_KINDS,
  VENDOR_STATUSES,
  vendorKindForCategory,
  orderVendorsForCategory,
  matchVendorByName,
  formatVendorPhone,
  vendorKey,
} from "@/lib/commercial/vendors/constants";
import { PURCHASE_CATEGORIES } from "@/lib/commercial/purchases/constants";
import {
  csvToRecords,
  cleanSfVendorExport,
  SF_PLACEHOLDER_VENDOR_NAMES,
  vendorSeedValuesSql,
  SEED_COLUMNS,
} from "@/lib/commercial/vendors/sf-seed";
import { filterVendorList } from "@/lib/commercial/vendors/list-view";
import { parseVendorForm } from "@/lib/commercial/vendors/input";
import { readVendorPick, VENDOR_PICK_FIELDS } from "@/lib/commercial/vendors/purchase-pick";

/**
 * Vendor directory (Katie 2026-09-15). Pure logic + the migration ARTIFACT:
 * the seed Karan pastes into Supabase is parsed back out of the SQL file and
 * checked, rather than trusting the generator that wrote it.
 */

const MIGRATION = "supabase/migrations/20260915191000_commercial_vendors.sql";

// ── A miniature SF export with every trap the real one has ─────────────────
const HEADER =
  "category,sf_account_id,name,sf_type,vendor_status,purchase_type,purchases_n,total_spend,phone,email,primary_contact,website,street,city,state,zip,legal_name,payment_terms,preferred_payment,compliance_status,w9,direct_deposit,sub_agreement_signed";
const row = (o: Record<string, string>) =>
  HEADER.split(",")
    .map((h) => {
      const v = o[h] ?? "";
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    })
    .join(",");
const FIXTURE = [
  HEADER,
  row({ category: "Retail", sf_account_id: "A1", name: "Aboffs", vendor_status: "Active", purchase_type: "Paint", total_spend: "900", primary_contact: "Acct #917-886-8114 (Alex's)" }),
  row({ category: "Retail", sf_account_id: "P1", name: "Retail Vendor", vendor_status: "Active", purchases_n: "46", total_spend: "17000" }),
  row({ category: "Retail", sf_account_id: "P2", name: "Gas Station", vendor_status: "Active", total_spend: "1600" }),
  row({ category: "Retail", sf_account_id: "G1", name: "GTS Builders Supply", vendor_status: "Active", total_spend: "421.90" }),
  row({ category: "Retail", sf_account_id: "G2", name: "GTS Builders Supply", vendor_status: "", total_spend: "173.98", phone: "631-585-7171", street: "4701 Veterans Memorial Highway", city: "Holbrook", state: "NY", zip: "11741" }),
  row({ category: "Reimbursement payee", sf_account_id: "G3", name: "GTS Builders Supply", sf_type: "Prospect", total_spend: "247.92" }),
  row({ category: "Retail", sf_account_id: "B1", name: "Brinkmann's Hardware", vendor_status: "Active", total_spend: "4046", street: "226 Railroad Ave #100", city: "NY 11782", state: "NY", zip: "" }),
  row({ category: "Retail", sf_account_id: "U1", name: "United rentals", vendor_status: "Active", total_spend: "53" }),
  row({ category: "Labor", sf_account_id: "L1", name: "Tomco Labor - Erick", vendor_status: "Active", total_spend: "53988", street: "2929 East Commercial Boulevard\n#205", city: "Fort Lauderdale", state: "FL", zip: "33308" }),
  row({ category: "Labor", sf_account_id: "L2", name: "Omar LI", vendor_status: "Active", total_spend: "19590", phone: "6316275798", email: "SorianoPainting278@gmail.com", primary_contact: "Omar Flores", legal_name: "Custom Quality Painting Inc", preferred_payment: "ACH", w9: "true", direct_deposit: "true", sub_agreement_signed: "2025-02-19" }),
  row({ category: "Labor", sf_account_id: "L3", name: "LC Cristhian Plaza", vendor_status: "Active", total_spend: "300", website: "www.precisionpaintingplus.net" }),
  row({ category: "Reimbursement payee", sf_account_id: "R1", name: "Precision Painting Plus LLC", vendor_status: "Active", total_spend: "11280" }),
  row({ category: "Reimbursement payee", sf_account_id: "R2", name: "TLA Contracting", vendor_status: "Inactive", total_spend: "8961" }),
].join("\n");

describe("SF vendor export → seed", () => {
  const { vendors, decisions } = cleanSfVendorExport(csvToRecords(FIXTURE));
  const byName = new Map(vendors.map((v) => [v.name, v]));

  it("drops the catch-all placeholders and says why", () => {
    expect(byName.has("Retail Vendor")).toBe(false);
    expect(byName.has("Gas Station")).toBe(false);
    const d = decisions.find((x) => x.sfName === "Retail Vendor")!;
    expect(d.decision).toBe("excluded");
    expect(d.reason).toMatch(/placeholder/i);
  });

  it("merges duplicate SF accounts — including a reimbursement Prospect — into one vendor with every id", () => {
    const gts = vendors.filter((v) => vendorKey(v.name) === vendorKey("GTS Builders Supply"));
    expect(gts).toHaveLength(1);
    expect([...gts[0].sf_account_ids].sort()).toEqual(["G1", "G2", "G3"]);
    // Blanks on the biggest record are filled from the others.
    expect(gts[0].phone).toBe("(631) 585-7171");
    expect(gts[0].city).toBe("Holbrook");
    // One blank-status record must not deactivate a store the others use.
    expect(gts[0].status).toBe("active");
  });

  it("does not seed reimbursement-only payees", () => {
    expect(byName.has("Precision Painting Plus LLC")).toBe(false);
    expect(byName.has("TLA Contracting")).toBe(false);
    expect(decisions.find((d) => d.sfName === "TLA Contracting")!.reason).toMatch(/inactive/);
  });

  it("maps category to kind", () => {
    expect(byName.get("Aboffs")!.kind).toBe("retail");
    expect(byName.get("Tomco Labor - Erick")!.kind).toBe("labor");
    expect(byName.get("Omar LI")!.kind).toBe("labor");
  });

  it("cleans the fields SF got wrong", () => {
    // "Acct #…" is an account number, not a person.
    expect(byName.get("Aboffs")!.contact_name).toBeNull();
    expect(byName.get("Aboffs")!.notes).toContain("917-886-8114");
    // "NY 11782" is not a city.
    expect(byName.get("Brinkmann's Hardware")!.city).toBeNull();
    expect(byName.get("Brinkmann's Hardware")!.zip).toBe("11782");
    // A quoted multi-line street survives the CSV parse as one field.
    expect(byName.get("Tomco Labor - Erick")!.address_line1).toBe("2929 East Commercial Boulevard, #205");
    expect(byName.get("Tomco Labor - Erick")!.zip).toBe("33308");
    expect(byName.get("Omar LI")!.phone).toBe("(631) 627-5798");
    expect(byName.get("Omar LI")!.email).toBe("sorianopainting278@gmail.com");
    expect(byName.get("Omar LI")!.w9_on_file).toBe(true);
    expect(byName.get("Omar LI")!.notes).toContain("Custom Quality Painting Inc");
    // PPP's own website is not the sub's.
    expect(byName.get("LC Cristhian Plaza")!.website).toBeNull();
    expect(byName.has("United Rentals")).toBe(true);
  });

  it("accounts for every SF row exactly once", () => {
    expect(decisions).toHaveLength(csvToRecords(FIXTURE).length);
  });

  it("escapes quotes in the generated SQL", () => {
    const sql = vendorSeedValuesSql(vendors);
    expect(sql).toContain("'Brinkmann''s Hardware'");
    expect(sql).toContain("(Alex''s)");
  });
});

// ── The artifact: the seed as it actually sits in the migration ────────────

/** Split the migration's `from (values …) as s` block into SQL tuples. */
function seedTuples(sql: string): string[][] {
  const start = sql.indexOf("from (values");
  const end = sql.indexOf(") as s (", start);
  expect(start, "seed VALUES block not found").toBeGreaterThan(-1);
  const body = sql.slice(start + "from (values".length, end);
  const tuples: string[][] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "(") { i++; continue; }
    // Parse one tuple, respecting quoted strings ('' escapes) and ARRAY[…].
    const fields: string[] = [];
    let cur = "";
    let depth = 0;
    let inStr = false;
    i++;
    for (; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        if (c === "'" && body[i + 1] === "'") { cur += "'"; i++; }
        else if (c === "'") inStr = false;
        else cur += c;
        continue;
      }
      if (c === "'") { inStr = true; continue; }
      if (c === "[" || c === "(") depth++;
      if ((c === "]" || c === ")") && depth > 0) { depth--; cur += c; continue; }
      if (c === ")" && depth === 0) { fields.push(cur.trim()); i++; break; }
      if (c === "," && depth === 0) { fields.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    tuples.push(fields);
  }
  return tuples;
}

describe("the migration's seed", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const tuples = seedTuples(sql);
  const col = (name: (typeof SEED_COLUMNS)[number]) => SEED_COLUMNS.indexOf(name);
  const names = tuples.map((t) => t[col("name")]);

  it("has one field per column on every row", () => {
    expect(tuples.length).toBeGreaterThan(0);
    for (const t of tuples) expect(t, t[0]).toHaveLength(SEED_COLUMNS.length);
  });

  it("is 44 vendors: 28 retail, 16 labor", () => {
    const kinds = tuples.map((t) => t[col("kind")]);
    expect(tuples).toHaveLength(44);
    expect(kinds.filter((k) => k === "retail")).toHaveLength(28);
    expect(kinds.filter((k) => k === "labor")).toHaveLength(16);
  });

  it("contains no placeholder and no reimbursement-only payee", () => {
    const keys = new Set(names.map(vendorKey));
    for (const p of [...SF_PLACEHOLDER_VENDOR_NAMES, "Precision Painting Plus LLC", "TLA Contracting", "ART"]) {
      expect(keys.has(vendorKey(p)), p).toBe(false);
    }
  });

  it("has no two vendors the directory would treat as the same", () => {
    const keys = names.map(vendorKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it("only uses kinds and statuses the CHECK allows", () => {
    for (const t of tuples) {
      expect(VENDOR_KINDS as readonly string[]).toContain(t[col("kind")]);
      expect(VENDOR_STATUSES as readonly string[]).toContain(t[col("status")]);
    }
  });

  it("keeps every SF id of the merged duplicates", () => {
    const gts = tuples.find((t) => t[col("name")] === "GTS Builders Supply")!;
    expect(gts[col("sf_account_ids")].match(/0[0-9A-Za-z]{17}/g)).toHaveLength(3);
    const sp = tuples.find((t) => t[col("name")] === "SP Sign Warehouse")!;
    expect(sp[col("sf_account_ids")].match(/0[0-9A-Za-z]{17}/g)).toHaveLength(2);
  });

  it("is idempotent and says the wipe must keep it", () => {
    const code = sql.replace(/--[^\n]*/g, "");
    expect(code).toMatch(/where not exists\s*\(/i);
    expect(code).toMatch(/on conflict do nothing/i);
    expect(sql).toMatch(/WIPE MUST KEEP commercial_vendors/);
    // …and the wipe script really doesn't delete from it.
    const wipe = readFileSync("scripts/wipe-commercial-data.sql", "utf8").replace(/--[^\n]*/g, "");
    expect(wipe).not.toMatch(/delete\s+from\s+(public\.)?commercial_vendors/i);
  });
});

describe("VENDOR_KINDS / VENDOR_STATUSES match the migration CHECK exactly", () => {
  const code = readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
  const checkValues = (column: string) => {
    const m = new RegExp(`\\b${column}\\s+text[^,]*?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, "i").exec(code);
    expect(m, `no CHECK on ${column}`).not.toBeNull();
    return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  it("kind", () => expect(checkValues("kind")).toEqual([...VENDOR_KINDS].sort()));
  it("status", () => expect(checkValues("status")).toEqual([...VENDOR_STATUSES].sort()));
});

// ── Purchase picker ────────────────────────────────────────────────────────

describe("which vendors a purchase category lists first", () => {
  it("labor and subcontractor ask for labor vendors; everything else for retail", () => {
    const expected: Record<string, string> = {
      materials: "retail",
      labor: "labor",
      // Tomco's own crew. A payout to them is somebody's time, so the payee
      // list should offer people rather than paint suppliers.
      employee_labor: "labor",
      subcontractor: "labor",
      equipment: "retail",
      permit: "retail",
      other: "retail",
    };
    // Every category the app offers is decided — a new one must be placed.
    expect(Object.keys(expected).sort()).toEqual([...PURCHASE_CATEGORIES].sort());
    for (const c of PURCHASE_CATEGORIES) expect(vendorKindForCategory(c), c).toBe(expected[c]);
    expect(vendorKindForCategory("something-new")).toBe("retail");
  });

  const list = [
    { name: "Sherwin-Williams", kind: "retail" },
    { name: "Tomco Labor - Greg", kind: "labor" },
    { name: "aboffs", kind: "retail" },
    { name: "LC RA Jose", kind: "labor" },
  ];

  it("puts the asked-for kind first, A→Z inside each group, and hides nothing", () => {
    expect(orderVendorsForCategory(list, "labor").map((v) => v.name)).toEqual([
      "LC RA Jose",
      "Tomco Labor - Greg",
      "aboffs",
      "Sherwin-Williams",
    ]);
    expect(orderVendorsForCategory(list, "materials").map((v) => v.name)).toEqual([
      "aboffs",
      "Sherwin-Williams",
      "LC RA Jose",
      "Tomco Labor - Greg",
    ]);
  });
});

describe("matching a typed name to the directory", () => {
  const dir = [
    { id: "1", name: "Sherwin-Williams", status: "active" },
    { id: "2", name: "Home Depot", status: "inactive" },
    { id: "3", name: "Home Depot Inc", status: "active" },
  ];
  it("ignores case, punctuation and company suffixes", () => {
    expect(matchVendorByName(dir, "sherwin williams")?.id).toBe("1");
    expect(matchVendorByName(dir, "  SHERWIN-WILLIAMS  ")?.id).toBe("1");
  });
  it("prefers an active vendor over an inactive one with the same key", () => {
    expect(matchVendorByName(dir, "home depot")?.id).toBe("3");
  });
  it("does not match a partial name", () => {
    expect(matchVendorByName(dir, "Sherwin")).toBeNull();
    expect(matchVendorByName(dir, "")).toBeNull();
  });
});

describe("the vendor picker's hidden fields reach the action", () => {
  const form = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k] : null) });
  const id = "3f2c1a4e-8b7d-4c21-9e1f-0a2b3c4d5e6f";
  it("reads the id and the add-new tap under the names the form renders", () => {
    const pick = readVendorPick(form({ [VENDOR_PICK_FIELDS.id]: id, [VENDOR_PICK_FIELDS.createNew]: "1" }));
    expect(pick).toEqual({ id, createNew: true, preserve: { pu_vid: id, pu_vnew: "1" } });
  });
  it("drops a forged id", () => {
    expect(readVendorPick(form({ [VENDOR_PICK_FIELDS.id]: "'; drop table" })).id).toBeNull();
    expect(readVendorPick(form({})).createNew).toBe(false);
  });
});

// ── Settings page ──────────────────────────────────────────────────────────

describe("Settings → Vendors list", () => {
  const vendors = [
    { name: "Aboffs", kind: "retail", status: "active", specialty: "Paint", phone: null },
    { name: "Sunbelt Rentals", kind: "retail", status: "active", specialty: "Equipment Rental", phone: "(631) 585-7171" },
    { name: "Tomco Labor - Greg", kind: "labor", status: "active" },
    { name: "TLA Contracting", kind: "labor", status: "inactive" },
  ];
  it("All leaves inactive vendors out; Inactive shows only them", () => {
    const all = filterVendorList(vendors, { q: "", view: "all" });
    expect(all.rows.map((v) => v.name)).not.toContain("TLA Contracting");
    expect(all.counts).toEqual({ all: 3, retail: 2, labor: 1, inactive: 1 });
    expect(filterVendorList(vendors, { q: "", view: "inactive" }).rows.map((v) => v.name)).toEqual(["TLA Contracting"]);
  });
  it("chip counts follow the search", () => {
    const r = filterVendorList(vendors, { q: "paint", view: "all" });
    expect(r.rows.map((v) => v.name)).toEqual(["Aboffs"]);
    expect(r.counts).toEqual({ all: 1, retail: 1, labor: 0, inactive: 0 });
  });
  it("finds a phone by its digits", () => {
    expect(filterVendorList(vendors, { q: "585 7171", view: "all" }).rows.map((v) => v.name)).toEqual(["Sunbelt Rentals"]);
  });
});

describe("vendor form parsing", () => {
  const form = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k] : null) });
  it("requires a name and tidies what it can", () => {
    expect(parseVendorForm(form({ name: "   " })).ok).toBe(false);
    const r = parseVendorForm(form({ name: "  Joe's   Hardware ", kind: "labor", phone: "16315551234", email: "Desk@Joes.COM", state: "ny", w9_on_file: "on", notes: "  " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ name: "Joe's Hardware", kind: "labor", phone: "(631) 555-1234", email: "desk@joes.com", state: "NY", w9_on_file: true, notes: null });
  });
  it("never lets a forged kind through", () => {
    const r = parseVendorForm(form({ name: "X", kind: "admin" }));
    expect(r.ok && r.value.kind).toBe("retail");
  });
  it("leaves a non-US phone as typed", () => {
    expect(formatVendorPhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
  });
});
