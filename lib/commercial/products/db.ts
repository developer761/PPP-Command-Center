/**
 * Phase D Product Library — CRUD + list helpers.
 *
 * Karan 2026-07-13: SKU catalog + per-account price override list.
 * Audit-logged via `logInsert/logUpdate/logDelete` like every other
 * commercial table.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";

export type CommercialProduct = {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  default_unit_cost_cents: number | null;
  default_unit_price_cents: number;
  notes: string | null;
  // F.6 (2026-07-19): Katie's proposal notes → parent/variation + surface_area + description.
  parent_product_id: string | null;
  variation_label: string | null;
  surface_area: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
};

/** F.6: is this product sellable on a proposal? Parent products (rows
 *  that have children pointing at them via parent_product_id) are
 *  browse-only — Alex must pick a specific variation. Standalone
 *  products (no parent, no children) and variations (has a parent)
 *  are both sellable. */
export function isVariationParent(
  product: CommercialProduct,
  allProducts: CommercialProduct[]
): boolean {
  return allProducts.some((p) => p.parent_product_id === product.id);
}

export type CommercialCustomerPrice = {
  id: string;
  account_id: string;
  product_id: string;
  unit_price_cents: number;
  effective_from: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
};

// ────────────── product CRUD ──────────────

export type CreateProductInput = {
  sku: string;
  name: string;
  category?: string;
  unit?: string;
  default_unit_cost_cents?: number | null;
  default_unit_price_cents: number;
  notes?: string | null;
  // F.6: variation + surface + description.
  parent_product_id?: string | null;
  variation_label?: string | null;
  surface_area?: string;
  description?: string | null;
  is_active?: boolean;
  created_by_user_id?: string | null;
};

export async function createProduct(
  input: CreateProductInput
): Promise<
  | { ok: true; product: CommercialProduct }
  | { ok: false; error: string }
> {
  if (!input.sku.trim()) return { ok: false, error: "SKU is required." };
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  if (input.default_unit_price_cents < 0)
    return { ok: false, error: "Default price must be zero or greater." };
  if (
    input.default_unit_cost_cents != null &&
    input.default_unit_cost_cents < 0
  ) {
    return { ok: false, error: "Default cost must be zero or greater." };
  }
  // F.6 validation: variation label required when parent is set; and
  // parent can't itself be a variation (only two-level hierarchy).
  if (input.parent_product_id && !input.variation_label?.trim()) {
    return {
      ok: false,
      error:
        "Variation label is required when picking a parent product (e.g. \"Seal & Poly\").",
    };
  }
  if (!input.parent_product_id && input.variation_label?.trim()) {
    return {
      ok: false,
      error:
        "Variation label only applies when this product is a variation of a parent.",
    };
  }
  if (input.parent_product_id) {
    // Reject nested variations — parent must be a top-level product.
    const sb0 = commercialDb();
    const { data: parentCheck } = await sb0
      .from("commercial_products")
      .select("id, parent_product_id, deleted_at")
      .eq("id", input.parent_product_id)
      .maybeSingle();
    const parent = parentCheck as {
      id: string;
      parent_product_id: string | null;
      deleted_at: string | null;
    } | null;
    if (!parent || parent.deleted_at) {
      return { ok: false, error: "Parent product not found or archived." };
    }
    if (parent.parent_product_id) {
      return {
        ok: false,
        error:
          "Cannot nest variations. Pick a top-level product as the parent.",
      };
    }
  }
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_products")
    .insert({
      sku: input.sku.trim(),
      name: input.name.trim(),
      category: input.category ?? "other",
      unit: input.unit ?? "each",
      default_unit_cost_cents: input.default_unit_cost_cents ?? null,
      default_unit_price_cents: input.default_unit_price_cents,
      notes: input.notes?.trim() || null,
      parent_product_id: input.parent_product_id ?? null,
      variation_label: input.variation_label?.trim() || null,
      surface_area: input.surface_area ?? "other",
      description: input.description?.trim() || null,
      is_active: input.is_active ?? true,
      created_by_user_id: input.created_by_user_id ?? null,
      updated_by_user_id: input.created_by_user_id ?? null,
    })
    .select("*")
    .single();
  if (error) {
    // 23505 = unique_violation on sku
    if (
      error.code === "23505" ||
      /duplicate key|unique constraint/i.test(error.message)
    ) {
      return {
        ok: false,
        error: `SKU "${input.sku.trim()}" is already in the catalog. Pick a different SKU or archive the existing one first.`,
      };
    }
    return { ok: false, error: error.message };
  }
  const product = data as CommercialProduct;
  await logInsert(
    "commercial_products",
    product.id,
    product,
    input.created_by_user_id ?? null
  );
  return { ok: true, product };
}

export type UpdateProductInput = Partial<
  Omit<CreateProductInput, "created_by_user_id">
> & {
  id: string;
  updated_by_user_id?: string | null;
};

export async function updateProduct(
  input: UpdateProductInput
): Promise<
  | { ok: true; product: CommercialProduct }
  | { ok: false; error: string }
> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_products")
    .select("*")
    .eq("id", input.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Product not found." };
  const patch: Record<string, unknown> = {};
  if (input.sku !== undefined) {
    if (!input.sku.trim()) return { ok: false, error: "SKU is required." };
    patch.sku = input.sku.trim();
  }
  if (input.name !== undefined) {
    if (!input.name.trim())
      return { ok: false, error: "Name is required." };
    patch.name = input.name.trim();
  }
  if (input.category !== undefined) patch.category = input.category;
  if (input.unit !== undefined) patch.unit = input.unit;
  if (input.default_unit_cost_cents !== undefined) {
    if (
      input.default_unit_cost_cents != null &&
      input.default_unit_cost_cents < 0
    ) {
      return { ok: false, error: "Default cost must be zero or greater." };
    }
    patch.default_unit_cost_cents = input.default_unit_cost_cents;
  }
  if (input.default_unit_price_cents !== undefined) {
    if (input.default_unit_price_cents < 0)
      return { ok: false, error: "Default price must be zero or greater." };
    patch.default_unit_price_cents = input.default_unit_price_cents;
  }
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  // F.6: variation + surface + description patches. Same guards as create.
  if (input.parent_product_id !== undefined) {
    if (
      input.parent_product_id &&
      !(input.variation_label ?? (before as CommercialProduct).variation_label)?.trim()
    ) {
      return {
        ok: false,
        error:
          "Variation label is required when picking a parent product.",
      };
    }
    if (input.parent_product_id === input.id) {
      return { ok: false, error: "A product cannot be its own parent." };
    }
    if (input.parent_product_id) {
      const { data: parentCheck } = await sb
        .from("commercial_products")
        .select("id, parent_product_id, deleted_at")
        .eq("id", input.parent_product_id)
        .maybeSingle();
      const parent = parentCheck as {
        id: string;
        parent_product_id: string | null;
        deleted_at: string | null;
      } | null;
      if (!parent || parent.deleted_at) {
        return { ok: false, error: "Parent product not found or archived." };
      }
      if (parent.parent_product_id) {
        return { ok: false, error: "Cannot nest variations." };
      }
    }
    patch.parent_product_id = input.parent_product_id;
  }
  if (input.variation_label !== undefined) {
    patch.variation_label = input.variation_label?.trim() || null;
  }
  if (input.surface_area !== undefined) patch.surface_area = input.surface_area;
  if (input.description !== undefined) {
    patch.description = input.description?.trim() || null;
  }
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  patch.updated_by_user_id = input.updated_by_user_id ?? null;

  const { data: after, error } = await sb
    .from("commercial_products")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) {
    if (
      error.code === "23505" ||
      /duplicate key|unique constraint/i.test(error.message)
    ) {
      return {
        ok: false,
        error: "That SKU is already used by another live product.",
      };
    }
    return { ok: false, error: error.message };
  }
  const product = after as CommercialProduct;
  await logUpdate(
    "commercial_products",
    product.id,
    before,
    product,
    input.updated_by_user_id ?? null
  );
  return { ok: true, product };
}

export async function softDeleteProduct(
  id: string,
  deletedByUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_products")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Product not found." };
  const { error } = await sb
    .from("commercial_products")
    .update({
      deleted_at: new Date().toISOString(),
      updated_by_user_id: deletedByUserId ?? null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_products", id, before, deletedByUserId ?? null);
  return { ok: true };
}

export async function getProduct(id: string): Promise<CommercialProduct | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_products")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as CommercialProduct | null) ?? null;
}

export type ListProductsFilters = {
  q?: string;
  category?: string;
  surface_area?: string;
  includeInactive?: boolean;
};

export async function listProducts(
  filters: ListProductsFilters = {}
): Promise<CommercialProduct[]> {
  const sb = commercialDb();
  let query = sb
    .from("commercial_products")
    .select("*")
    .is("deleted_at", null);
  if (!filters.includeInactive) query = query.eq("is_active", true);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.surface_area) query = query.eq("surface_area", filters.surface_area);
  if (filters.q?.trim()) {
    const q = filters.q.trim();
    // Escape LIKE wildcards + backslash (same pattern as palette-search).
    // F.6: search also matches variation_label so typing "Seal & Poly"
    // finds the variation row directly.
    const safe = q.replace(/[\\%_]/g, "\\$&");
    query = query.or(
      `sku.ilike.%${safe}%,name.ilike.%${safe}%,variation_label.ilike.%${safe}%`
    );
  }
  const { data, error } = await query.order("name", { ascending: true }).limit(500);
  if (error) return [];
  return (data ?? []) as CommercialProduct[];
}

// ────────────── customer price overrides ──────────────

export type UpsertCustomerPriceInput = {
  account_id: string;
  product_id: string;
  unit_price_cents: number;
  effective_from?: string | null; // YYYY-MM-DD, or null for "always"
  notes?: string | null;
  actor_user_id?: string | null;
};

export async function upsertCustomerPrice(
  input: UpsertCustomerPriceInput
): Promise<
  | { ok: true; price: CommercialCustomerPrice }
  | { ok: false; error: string }
> {
  if (input.unit_price_cents < 0)
    return { ok: false, error: "Unit price must be zero or greater." };
  const sb = commercialDb();
  const effective = input.effective_from ?? null;
  // Look up an existing row with the same 3-tuple; update if present,
  // insert if not. Can't use `.upsert()` because the unique index is
  // over a coalesce() expression and Postgres won't match it as a
  // conflict target.
  const { data: existing } = await sb
    .from("commercial_customer_prices")
    .select("*")
    .eq("account_id", input.account_id)
    .eq("product_id", input.product_id)
    .filter(
      "effective_from",
      effective === null ? "is" : "eq",
      effective === null ? null : (effective as unknown as string)
    )
    .maybeSingle();
  if (existing) {
    const before = existing as CommercialCustomerPrice;
    const { data: after, error } = await sb
      .from("commercial_customer_prices")
      .update({
        unit_price_cents: input.unit_price_cents,
        notes: input.notes?.trim() || null,
        updated_by_user_id: input.actor_user_id ?? null,
      })
      .eq("id", before.id)
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };
    const price = after as CommercialCustomerPrice;
    await logUpdate(
      "commercial_customer_prices",
      price.id,
      before,
      price,
      input.actor_user_id ?? null
    );
    return { ok: true, price };
  }
  const { data, error } = await sb
    .from("commercial_customer_prices")
    .insert({
      account_id: input.account_id,
      product_id: input.product_id,
      unit_price_cents: input.unit_price_cents,
      effective_from: effective,
      notes: input.notes?.trim() || null,
      created_by_user_id: input.actor_user_id ?? null,
      updated_by_user_id: input.actor_user_id ?? null,
    })
    .select("*")
    .single();
  if (error) {
    // TOCTOU: two concurrent saves can both pass the existence
    // check above and race to INSERT. The unique index catches it
    // (Postgres 23505). Instead of surfacing a raw DB error, re-read
    // the winner and UPDATE it — the end state matches what the user
    // asked for either way.
    if (
      error.code === "23505" ||
      /duplicate key|unique constraint/i.test(error.message)
    ) {
      const { data: winner } = await sb
        .from("commercial_customer_prices")
        .select("*")
        .eq("account_id", input.account_id)
        .eq("product_id", input.product_id)
        .filter(
          "effective_from",
          effective === null ? "is" : "eq",
          effective === null ? null : (effective as unknown as string)
        )
        .maybeSingle();
      if (winner) {
        const before = winner as CommercialCustomerPrice;
        const { data: after, error: updErr } = await sb
          .from("commercial_customer_prices")
          .update({
            unit_price_cents: input.unit_price_cents,
            notes: input.notes?.trim() || null,
            updated_by_user_id: input.actor_user_id ?? null,
          })
          .eq("id", before.id)
          .select("*")
          .single();
        if (updErr) return { ok: false, error: updErr.message };
        const price = after as CommercialCustomerPrice;
        await logUpdate(
          "commercial_customer_prices",
          price.id,
          before,
          price,
          input.actor_user_id ?? null
        );
        return { ok: true, price };
      }
      // Extremely rare: 23505 tripped, but the winning row was
      // deleted between the failed INSERT and this re-SELECT. Surface
      // a friendlier message than the raw Postgres error.
      return {
        ok: false,
        error:
          "Another admin just changed this override — please refresh and try again.",
      };
    }
    return { ok: false, error: error.message };
  }
  const price = data as CommercialCustomerPrice;
  await logInsert(
    "commercial_customer_prices",
    price.id,
    price,
    input.actor_user_id ?? null
  );
  return { ok: true, price };
}

export async function deleteCustomerPrice(
  id: string,
  actorUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_customer_prices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Customer price not found." };
  const { error } = await sb
    .from("commercial_customer_prices")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logDelete(
    "commercial_customer_prices",
    id,
    before,
    actorUserId ?? null
  );
  return { ok: true };
}

export async function listCustomerPricesForProduct(
  productId: string
): Promise<CommercialCustomerPrice[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_customer_prices")
    .select("*")
    .eq("product_id", productId)
    .order("effective_from", { ascending: false, nullsFirst: false });
  return (data ?? []) as CommercialCustomerPrice[];
}

export async function listCustomerPricesForAccount(
  accountId: string
): Promise<CommercialCustomerPrice[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_customer_prices")
    .select("*")
    .eq("account_id", accountId)
    .order("effective_from", { ascending: false, nullsFirst: false });
  return (data ?? []) as CommercialCustomerPrice[];
}
