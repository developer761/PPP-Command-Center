import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Typed Supabase admin client for `commercial_*` tables.
 *
 * The New Platform is Postgres-native — every commercial_* table is the
 * source of truth. This client bypasses RLS (service role) on purpose; we
 * scope reads/writes at the application layer via `lib/commercial/rbac.ts`.
 *
 * Strict separation: do not export this client from any Command Center
 * module, and do not import Command Center's Supabase wrappers from here.
 * Keep the layers parallel.
 */

export function commercialDb() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Commercial role enum — matches the CHECK constraint in migration 019. */
export type CommercialRole =
  | "admin"
  | "estimator"
  | "pm"
  | "superintendent"
  | "foreman"
  | "office"
  | "field"
  // Scoped self-service login for the people doing the work (Karan 2026-08).
  // Unlike the others this role RESTRICTS rather than grants — see
  // lib/commercial/crew-access.ts. Holding it and nothing else confines the
  // login to an allowlist of field-ops surfaces.
  | "crew";
