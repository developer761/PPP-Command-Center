import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logUpdate } from "@/lib/commercial/audit-log";
import {
  RATING_CODES,
  FALLBACK_RATING_LABELS,
  type RatingCode,
  type RatingLabel,
} from "./rating-codes";

/**
 * What A / B / C mean (migration 143).
 *
 * Stephanie 2026-08-13 asked whether the rating system could be personalised.
 * The stored value stays A/B/C — renaming the codes would mean re-grading every
 * account and would break the list filter, the sort and the CSV export for
 * nothing. What is editable is the MEANING attached to each letter.
 */

export type { RatingCode, RatingLabel };

/**
 * Never throws and never returns a partial set: a missing row falls back to the
 * built-in text. A rating pill is on every account row, so a settings table
 * that has not been seeded yet must not blank the pills or take the page down.
 */
export async function getRatingLabels(): Promise<Record<RatingCode, RatingLabel>> {
  const out = { ...FALLBACK_RATING_LABELS };
  try {
    const { data } = await commercialDb()
      .from("commercial_account_rating_labels")
      .select("code, label, description");
    for (const r of (data ?? []) as { code: string; label: string | null; description: string | null }[]) {
      if (!RATING_CODES.includes(r.code as RatingCode)) continue;
      out[r.code as RatingCode] = {
        label: r.label?.trim() || FALLBACK_RATING_LABELS[r.code as RatingCode].label,
        description: r.description?.trim() || null,
      };
    }
  } catch {
    // Pre-migration, or a transient read failure. The fallbacks are correct
    // enough to render a page with.
  }
  return out;
}

export async function updateRatingLabel(input: {
  code: RatingCode;
  label: string;
  description: string | null;
  actorUserId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const label = input.label.trim().slice(0, 60);
  if (!label) return { ok: false, error: "Give the rating a name." };
  if (!RATING_CODES.includes(input.code)) return { ok: false, error: "Unknown rating." };

  const patch = {
    label,
    description: input.description?.trim().slice(0, 300) || null,
    updated_at: new Date().toISOString(),
    updated_by_user_id: input.actorUserId,
  };
  const { error } = await commercialDb()
    .from("commercial_account_rating_labels")
    .upsert({ code: input.code, ...patch });
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_account_rating_labels",
    input.code,
    {},
    patch,
    input.actorUserId
  ).catch(() => undefined);
  return { ok: true };
}
