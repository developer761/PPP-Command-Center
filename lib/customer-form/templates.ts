import "server-only";

import { createClient } from "@supabase/supabase-js";
import { colorDeadlineNotice } from "@/lib/customer-form/deadline-notice";

/**
 * Customer-form template system. Code-shipped defaults + DB-backed overrides
 * for every customer-facing string in the form/email pipeline.
 *
 * Flow:
 *   1. Default copy lives in DEFAULT_TEMPLATES below — survives any DB issue
 *   2. Admin edits via /dashboard/settings/templates → writes to
 *      customer_form_templates table (single-row, id='default')
 *   3. loadTemplates() merges DB row (if any non-null column) over defaults
 *   4. render() does Mustache-style {{variable}} substitution
 *
 * Variables available (all string|null — render handles nulls):
 *   - customer_name   ("Jane Doe" or "" if unknown)
 *   - customer_first  ("Jane" or "there" if unknown)
 *   - wo_number       ("00012345" or "" if unknown)
 *   - form_url        (full https://hub.../select/<token> URL)
 *   - ppp_brand       (constant — "Precision Painting Plus")
 *
 * Why single-row instead of a key-value table: one set of templates per
 * install, and SELECT * FROM customer_form_templates is the simplest
 * possible read path. If we ever need per-rep / per-territory variants
 * we'll evolve.
 */

export type Templates = {
  email_subject: string;
  email_intro: string;
  email_outro: string;
  email_signoff: string;
  /** Confirmation ("receipt") email, sent to the customer on submit — Kate
   *  2026-10-01. Editable for the same reason the invite copy is: the wording
   *  of a document meant to settle a dispute should not need a deploy. */
  confirm_subject: string;
  confirm_intro: string;
  confirm_outro: string;
  form_header_eyebrow: string;
  form_header_title: string;
  form_header_subtitle: string;
  form_intro_body: string;
  form_global_notes_label: string;
  form_thankyou_title: string;
  form_thankyou_body: string;
};

/** Code-shipped defaults. Mirror the hardcoded copy that was in the form +
 *  email helpers before this module existed. Admin overrides take priority. */
export const DEFAULT_TEMPLATES: Templates = {
  email_subject:
    "Action needed: Pick your paint colors (WO #{{wo_number}})",
  email_intro:
    "Thanks for choosing {{ppp_brand}}! We're getting ready to start your paint job (Work Order #{{wo_number}}) and need a few quick details from you — your color choices for each room.",
  // {{color_deadline_notice}} is always a full sentence (see
  // lib/customer-form/deadline-notice.ts) — the SAME sentence the form itself
  // shows, from one function, so the email and the page can never promise a
  // customer two different dates. Kate 2026-09-04.
  email_outro:
    "{{color_deadline_notice}}\n\nOnce you submit, we'll order materials and confirm your start date. The link is unique to your job — please don't share it.\n\nIf you have questions or want to add anything, just reply to this email.",
  email_signoff: "Thanks,\n{{ppp_brand}}",

  confirm_subject: "Your color selections — Work Order #{{wo_number}}",
  confirm_intro:
    "Thanks — we've got your color selections for Work Order #{{wo_number}}. Here's exactly what we received, so you can check it over.",
  // The edit button sits between these two paragraphs, so the outro follows on
  // from it. {{color_deadline_notice}} is the SAME sentence the form and the
  // invite use, from one function (Kate 2026-09-04) — three places that must
  // never promise a customer three different dates.
  confirm_outro:
    "If anything above isn't right, use the button to update it — your selections stay editable until we order the materials.\n\n{{color_deadline_notice}}\n\nIf you have questions, just reply to this email.",

  form_header_eyebrow: "Pick your paint colors",
  form_header_title: "Hi {{customer_first}} — let's lock in your colors",
  form_header_subtitle:
    "Below are the areas scoped during your appointment (Work Order #{{wo_number}}). For each surface, pick a color — type a name or code to search the catalog. You can add a finish and any notes for our team. We'll order the materials once you submit.",
  form_intro_body: "",

  form_global_notes_label: "Anything else we should know?",
  form_thankyou_title: "Got it — thanks!",
  form_thankyou_body:
    "Your color picks are with our team. We'll order the materials and reach out to confirm your start date. If anything changes, just reply to the email we sent you.",
};

type DBRow = Partial<Record<keyof Templates, string | null>> & {
  updated_at?: string;
  updated_by_user_id?: string | null;
};

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Load templates from Supabase + merge over code defaults. NEVER throws —
 * a missing migration, table-not-found, or RLS issue just returns the
 * defaults so customer-facing surfaces don't render blank.
 */
export async function loadTemplates(): Promise<{
  templates: Templates;
  isCustomized: boolean;
  updatedAt: string | null;
}> {
  try {
    const sb = adminClient();
    const { data, error } = await sb
      .from("customer_form_templates")
      .select("*")
      .eq("id", "default")
      .maybeSingle();
    if (error || !data) {
      return { templates: DEFAULT_TEMPLATES, isCustomized: false, updatedAt: null };
    }
    const row = data as DBRow;
    const merged: Templates = { ...DEFAULT_TEMPLATES };
    let any = false;
    for (const k of Object.keys(DEFAULT_TEMPLATES) as Array<keyof Templates>) {
      const v = row[k];
      if (typeof v === "string" && v.trim().length > 0) {
        merged[k] = v;
        any = true;
      }
    }
    return {
      templates: merged,
      isCustomized: any,
      updatedAt: row.updated_at ?? null,
    };
  } catch (err) {
    console.warn("[customer-form/templates] loadTemplates failed; falling back to defaults:", err);
    return { templates: DEFAULT_TEMPLATES, isCustomized: false, updatedAt: null };
  }
}

/**
 * Save admin edits to the DB. Pass an OBJECT of fields to update — only
 * keys present in the payload are written. To RESET a field back to the
 * code default, pass `null` for that key (writes null to DB, loadTemplates
 * skips it, defaults apply).
 */
export async function saveTemplates(
  patch: Partial<Record<keyof Templates, string | null>>,
  updatedByUserId?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const sb = adminClient();
    const update: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      // Pass through nulls explicitly so admin can clear a field
      if (v === null || (typeof v === "string")) {
        update[k] = v;
      }
    }
    if (updatedByUserId) update.updated_by_user_id = updatedByUserId;
    const { error } = await sb
      .from("customer_form_templates")
      .update(update)
      .eq("id", "default");
    if (!error) return { ok: true };

    // A column this build knows about but the database does not — the state
    // between shipping a new template field and somebody pasting the migration
    // into the SQL editor (there is no runner; see supabase/migrations/README).
    // The README's rule is that the app tolerates an un-applied migration, so
    // save everything that CAN be saved and say plainly what could not, rather
    // than failing the whole edit and losing the admin's other changes.
    const missing = missingColumnsFrom(error.message, Object.keys(update));
    if (missing.length === 0) return { ok: false, error: error.message };

    const retry: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(update)) {
      if (!missing.includes(k)) retry[k] = v;
    }
    if (Object.keys(retry).length === 0) {
      return { ok: false, error: `Not saved — the database is missing ${missing.join(", ")}. Run the latest migration in supabase/migrations.` };
    }
    const { error: retryError } = await sb
      .from("customer_form_templates")
      .update(retry)
      .eq("id", "default");
    if (retryError) return { ok: false, error: retryError.message };
    return {
      ok: false,
      error: `Saved everything except ${missing.join(", ")} — those columns don't exist yet. Run the latest migration in supabase/migrations, then save again.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Which of the columns we tried to write does Postgres say it doesn't have?
 *
 * PostgREST surfaces 42703 as a message naming ONE column
 * (`column "confirm_intro" of relation "customer_form_templates" does not
 * exist`), so the quoted name is matched against what we actually sent rather
 * than trusted blindly — and the whole candidate set is intersected, because a
 * second missing column only reveals itself on the retry. Returns [] for any
 * other failure, which keeps a real error (RLS, constraint) loud instead of
 * being mistaken for a pending migration.
 */
function missingColumnsFrom(message: string, attempted: string[]): string[] {
  if (!/does not exist/i.test(message)) return [];
  const named = Array.from(message.matchAll(/"([a-z0-9_]+)"/gi)).map((m) => m[1]);
  return attempted.filter((c) => named.includes(c));
}

/**
 * Mustache-lite variable substitution. Replaces every `{{key}}` with the
 * stringified value from `vars`. Unknown variables are left as the literal
 * `{{key}}` so misnamed placeholders are obvious in QA rather than silently
 * stripped to empty.
 */
export function render(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (full, key) => {
    const v = vars[key];
    if (v === undefined) return full; // keep literal for visibility in QA
    return v === null ? "" : v;
  });
}

/** Build the variable bag every template should receive. */
export function buildVars(input: {
  customerName?: string | null;
  workOrderNumber?: string | null;
  formUrl?: string | null;
  /** `customer_form_tokens.color_deadline` (YYYY-MM-DD) — the date the sender
   *  promised, when they set one. Absent falls back to the start-date wording. */
  colorDeadline?: string | null;
}): Record<string, string> {
  const name = (input.customerName ?? "").trim();
  const first = name ? name.split(/\s+/)[0] : "there";
  return {
    customer_name: name,
    customer_first: first,
    wo_number: (input.workOrderNumber ?? "").trim(),
    form_url: (input.formUrl ?? "").trim(),
    ppp_brand: "Precision Painting Plus",
    color_deadline_notice: colorDeadlineNotice(input.colorDeadline).text,
  };
}
