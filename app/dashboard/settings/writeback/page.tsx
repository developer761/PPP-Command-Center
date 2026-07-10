import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import PageHeader from "@/components/page-header";
import {
  getWritebackMode,
  loadAllowlist,
  type WritebackMode,
} from "@/lib/customer-form/writeback-mode";

/**
 * Writeback Settings — admin-only page for managing the customer-form
 * Salesforce writeback gate (migration 015). Katie hit the invisible
 * gate 2026-07-08: her test WO submission saved in Command Center but
 * didn't reach Salesforce because the WO wasn't on the allowlist and
 * mode was still `test_only`. Nothing surfaced that in a way she could
 * self-serve. This page fixes that:
 *
 *   - Big current-mode card (test_only / all / off) with radio + confirm
 *     to flip. Copy explains the risk of each choice in plain English.
 *   - Allowlist manager: paste a Salesforce WO Id (starts with 0WO),
 *     optional label, click Add. Rows show label + when added + who
 *     added it, with a Remove button.
 *   - Sticky hint linking to migration 015 SQL if the tables don't
 *     exist yet, so a first-time visit doesn't leave them staring at
 *     an empty state with no clue what to do.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{
  ok?: string;
  err?: string;
  removed?: string;
}>;

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Salesforce Id shape check — 15 or 18 char alphanumeric starting with 0WO. */
const WO_ID_RE = /^0WO[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/;

async function requireAdmin(): Promise<{ userId: string; email: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/dashboard");
  return { userId: user.id, email: user.email ?? null };
}

async function setModeAction(formData: FormData) {
  "use server";
  const ctx = await requireAdmin();
  const raw = String(formData.get("mode") ?? "").trim();
  if (raw !== "test_only" && raw !== "all" && raw !== "off") {
    redirect("/dashboard/settings/writeback?err=" + encodeURIComponent("Pick one of the three modes."));
  }
  try {
    const sb = adminClient();
    const { error } = await sb
      .from("customer_form_writeback_settings")
      .upsert(
        {
          key: "global",
          mode: raw,
          updated_by: ctx.email,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
    if (error) throw error;
  } catch (err) {
    redirect(
      "/dashboard/settings/writeback?err=" +
        encodeURIComponent(
          `Couldn't save the mode: ${err instanceof Error ? err.message : String(err)}. If the settings table doesn't exist yet, run migration 015 first.`
        )
    );
  }
  revalidatePath("/dashboard/settings/writeback");
  redirect(
    "/dashboard/settings/writeback?ok=" +
      encodeURIComponent(
        raw === "all"
          ? "Writeback is now LIVE for every work order. Customer form submissions will write to Salesforce immediately."
          : raw === "test_only"
          ? "Writeback is in test mode. Only WOs on the allowlist below will write to Salesforce."
          : "Writeback is paused. No customer form submissions will write to Salesforce."
      )
  );
}

async function addToAllowlistAction(formData: FormData) {
  "use server";
  const ctx = await requireAdmin();
  const woId = String(formData.get("work_order_id") ?? "").trim();
  const rawLabel = String(formData.get("label") ?? "").trim();
  const label = rawLabel.slice(0, 200) || null;
  if (!woId) {
    redirect("/dashboard/settings/writeback?err=" + encodeURIComponent("Paste a Salesforce work order Id."));
  }
  if (!WO_ID_RE.test(woId)) {
    redirect(
      "/dashboard/settings/writeback?err=" +
        encodeURIComponent(
          `"${woId}" doesn't look like a Salesforce WO Id (should start with 0WO and be 15 or 18 characters).`
        )
    );
  }
  try {
    const sb = adminClient();
    const { error } = await sb
      .from("customer_form_writeback_allowlist")
      .upsert(
        {
          work_order_id: woId,
          label,
          added_by: ctx.email,
          added_at: new Date().toISOString(),
        },
        { onConflict: "work_order_id" }
      );
    if (error) throw error;
  } catch (err) {
    redirect(
      "/dashboard/settings/writeback?err=" +
        encodeURIComponent(
          `Couldn't add to the allowlist: ${err instanceof Error ? err.message : String(err)}. If the allowlist table doesn't exist yet, run migration 015 first.`
        )
    );
  }
  revalidatePath("/dashboard/settings/writeback");
  redirect(
    "/dashboard/settings/writeback?ok=" +
      encodeURIComponent(
        `Added ${woId} to the allowlist${label ? ` (${label})` : ""}. Customer submissions for this WO will now write to Salesforce.`
      )
  );
}

async function bulkAddToAllowlistAction(formData: FormData) {
  "use server";
  const ctx = await requireAdmin();
  const raw = String(formData.get("work_order_ids") ?? "");
  const label = String(formData.get("label") ?? "").trim().slice(0, 200) || null;
  // Split on any whitespace, comma, or semicolon so a pasted column, a
  // comma-list, or an email dump all parse the same way. Dedupe.
  const tokens = Array.from(
    new Set(raw.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean))
  );
  if (tokens.length === 0) {
    redirect("/dashboard/settings/writeback?err=" + encodeURIComponent("Paste at least one Salesforce work order Id."));
  }
  const valid = tokens.filter((t) => WO_ID_RE.test(t));
  const invalid = tokens.filter((t) => !WO_ID_RE.test(t));
  if (valid.length === 0) {
    redirect(
      "/dashboard/settings/writeback?err=" +
        encodeURIComponent(
          `None of the ${tokens.length} pasted value${tokens.length === 1 ? "" : "s"} look like a Salesforce WO Id (should start with 0WO and be 15 or 18 characters).`
        )
    );
  }
  try {
    const sb = adminClient();
    const nowIso = new Date().toISOString();
    const { error } = await sb.from("customer_form_writeback_allowlist").upsert(
      valid.map((woId) => ({
        work_order_id: woId,
        label,
        added_by: ctx.email,
        added_at: nowIso,
      })),
      { onConflict: "work_order_id" }
    );
    if (error) throw error;
  } catch (err) {
    redirect(
      "/dashboard/settings/writeback?err=" +
        encodeURIComponent(
          `Couldn't add the batch: ${err instanceof Error ? err.message : String(err)}. If the allowlist table doesn't exist yet, run migration 015 first.`
        )
    );
  }
  revalidatePath("/dashboard/settings/writeback");
  redirect(
    "/dashboard/settings/writeback?ok=" +
      encodeURIComponent(
        `Added ${valid.length} work order${valid.length === 1 ? "" : "s"} to the allowlist.` +
          (invalid.length > 0
            ? ` Skipped ${invalid.length} value${invalid.length === 1 ? "" : "s"} that didn't look like a WO Id: ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? "…" : ""}.`
            : "")
      )
  );
}

async function removeFromAllowlistAction(formData: FormData) {
  "use server";
  await requireAdmin();
  const woId = String(formData.get("work_order_id") ?? "").trim();
  if (!woId) redirect("/dashboard/settings/writeback");
  try {
    const sb = adminClient();
    const { error } = await sb
      .from("customer_form_writeback_allowlist")
      .delete()
      .eq("work_order_id", woId);
    if (error) throw error;
  } catch (err) {
    redirect(
      "/dashboard/settings/writeback?err=" +
        encodeURIComponent(
          `Couldn't remove: ${err instanceof Error ? err.message : String(err)}`
        )
    );
  }
  revalidatePath("/dashboard/settings/writeback");
  redirect("/dashboard/settings/writeback?removed=" + encodeURIComponent(woId));
}

function modeLabel(m: WritebackMode): string {
  if (m === "all") return "Live — writes to Salesforce for every WO";
  if (m === "test_only") return "Test mode — only WOs on the allowlist below write to Salesforce";
  return "Paused — no writes to Salesforce (submissions still save in Command Center)";
}

function ModeCard({
  mode,
  value,
  title,
  desc,
  tone,
}: {
  mode: WritebackMode;
  value: WritebackMode;
  title: string;
  desc: string;
  tone: "emerald" | "amber" | "rose";
}) {
  const selected = mode === value;
  const toneRing =
    tone === "emerald"
      ? "peer-checked:ring-emerald-500 peer-checked:bg-emerald-50"
      : tone === "amber"
      ? "peer-checked:ring-amber-500 peer-checked:bg-amber-50"
      : "peer-checked:ring-rose-500 peer-checked:bg-rose-50";
  const toneChip =
    tone === "emerald"
      ? "bg-emerald-100 text-emerald-700"
      : tone === "amber"
      ? "bg-amber-100 text-amber-700"
      : "bg-rose-100 text-rose-700";
  return (
    <label className="flex-1 cursor-pointer">
      <input
        type="radio"
        name="mode"
        value={value}
        defaultChecked={selected}
        className="peer sr-only"
      />
      <div className={`h-full rounded-xl border border-ppp-charcoal-100 p-4 ring-2 ring-transparent transition-all ${toneRing}`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${toneChip}`}>
            {value}
          </span>
          {selected && (
            <span className="text-[11px] text-ppp-charcoal-500 font-medium">Current</span>
          )}
        </div>
        <div className="text-sm font-semibold text-ppp-charcoal mb-1">{title}</div>
        <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed">{desc}</p>
      </div>
    </label>
  );
}

function fmtEt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default async function WritebackSettingsPage({ searchParams }: { searchParams: SP }) {
  await requireAdmin();
  const sp = await searchParams;
  const [mode, allowlist] = await Promise.all([getWritebackMode(), loadAllowlist()]);

  const ok = sp.ok ? decodeURIComponent(sp.ok) : "";
  const err = sp.err ? decodeURIComponent(sp.err) : "";
  const removed = sp.removed ? decodeURIComponent(sp.removed) : "";

  return (
    <div className="animate-fade-up space-y-6 max-w-5xl">
      <PageHeader
        title="Salesforce Writeback"
        subtitle="Control whether customer color-form submissions write back to Salesforce. Every submission is always saved in Command Center — this gate only affects the outbound Salesforce writes."
      />

      {/* Flash banners */}
      {ok && (
        <div className="rounded-xl border-l-4 border-emerald-500 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {ok}
        </div>
      )}
      {err && (
        <div className="rounded-xl border-l-4 border-rose-500 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          {err}
        </div>
      )}
      {removed && (
        <div className="rounded-xl border-l-4 border-ppp-charcoal-400 bg-ppp-charcoal-50 px-4 py-3 text-sm text-ppp-charcoal-800">
          Removed <code className="font-mono text-[12px]">{removed}</code> from the allowlist. Future submissions for this WO will no longer write to Salesforce.
        </div>
      )}

      {/* Current state */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white p-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-ppp-charcoal-500 mb-1">
          Right now
        </div>
        <div className="text-base font-semibold text-ppp-charcoal">
          {modeLabel(mode)}
        </div>
        {mode === "test_only" && (
          <div className="mt-1 text-sm text-ppp-charcoal-500">
            {allowlist.length === 0
              ? "The allowlist is empty — NO work orders are writing to Salesforce right now."
              : `${allowlist.length} work order${allowlist.length === 1 ? "" : "s"} on the allowlist.`}
          </div>
        )}
      </section>

      {/* Mode picker */}
      <form action={setModeAction} className="rounded-xl border border-ppp-charcoal-100 bg-white p-5 space-y-4">
        <div>
          <h2 className="text-sm font-bold text-ppp-charcoal">Choose a mode</h2>
          <p className="text-[13px] text-ppp-charcoal-500 mt-0.5">
            Pick one and hit Save. Changes take effect on the next customer form submission.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <ModeCard
            mode={mode}
            value="all"
            title="Live"
            desc="Every customer submission writes back to Salesforce. Use this once you're confident the platform is working correctly."
            tone="emerald"
          />
          <ModeCard
            mode={mode}
            value="test_only"
            title="Test mode"
            desc="Only work orders on the allowlist below write to Salesforce. Useful during onboarding or when validating new SF field behavior."
            tone="amber"
          />
          <ModeCard
            mode={mode}
            value="off"
            title="Paused"
            desc="No writes to Salesforce at all. Submissions still save in Command Center; reconcile with SF manually later."
            tone="rose"
          />
        </div>
        <div className="flex items-center justify-between pt-2">
          <p className="text-[12px] text-ppp-charcoal-500">
            Note: changes are audit-logged. Read the mode + last update from
            <code className="font-mono text-[11px] mx-1 px-1.5 py-0.5 bg-ppp-charcoal-50 rounded">customer_form_writeback_settings</code>.
          </p>
          <button
            type="submit"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 min-h-[44px] shadow-sm shadow-emerald-600/30"
          >
            Save mode
          </button>
        </div>
      </form>

      {/* Allowlist */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white p-5 space-y-4">
        <div>
          <h2 className="text-sm font-bold text-ppp-charcoal">Test-mode allowlist</h2>
          <p className="text-[13px] text-ppp-charcoal-500 mt-0.5">
            When mode is <strong>Test mode</strong>, only these work orders write to Salesforce. Paste a Salesforce WO Id (starts with <code className="font-mono text-[11px] px-1 py-0.5 bg-ppp-charcoal-50 rounded">0WO</code>) and hit Add.
          </p>
        </div>

        <form action={addToAllowlistAction} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 items-end">
          <label className="flex flex-col gap-1 min-w-0">
            <span className="text-[12px] font-semibold text-ppp-charcoal-700">Work order Id</span>
            <input
              name="work_order_id"
              placeholder="0WOWj000007AwUvOAK"
              required
              autoComplete="off"
              className="rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
            />
          </label>
          <label className="flex flex-col gap-1 min-w-0">
            <span className="text-[12px] font-semibold text-ppp-charcoal-700">
              Label <span className="font-normal text-ppp-charcoal-500">(optional)</span>
            </span>
            <input
              name="label"
              placeholder="Katie's test — 2026-07-08"
              maxLength={200}
              autoComplete="off"
              className="rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
            />
          </label>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 min-h-[44px] shadow-sm shadow-emerald-600/30"
          >
            Add
          </button>
        </form>

        {/* Bulk add — paste a whole list (e.g. Katie emails 25 WO Ids at once). */}
        <details className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/40">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-semibold text-ppp-charcoal-700 hover:text-ppp-charcoal">
            Add several at once
          </summary>
          <form action={bulkAddToAllowlistAction} className="px-4 pb-4 pt-1 space-y-3">
            <p className="text-[12px] text-ppp-charcoal-500">
              Paste multiple work order Ids — one per line, or comma-separated. Anything that isn&apos;t a valid <code className="font-mono text-[11px] px-1 py-0.5 bg-white rounded">0WO…</code> Id is skipped and reported back. Re-adding an existing WO is a no-op.
            </p>
            <textarea
              name="work_order_ids"
              required
              rows={6}
              placeholder={"0WOWj000007AwUvOAK\n0WOWj000007FEmbOAG\n0WOWj000007FHfdOAG"}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
              <label className="flex flex-col gap-1 min-w-0">
                <span className="text-[12px] font-semibold text-ppp-charcoal-700">
                  Label for the whole batch <span className="font-normal text-ppp-charcoal-500">(optional)</span>
                </span>
                <input
                  name="label"
                  placeholder="Katie batch — 2026-07-09"
                  maxLength={200}
                  autoComplete="off"
                  className="rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
                />
              </label>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 min-h-[44px] shadow-sm shadow-emerald-600/30"
              >
                Add all
              </button>
            </div>
          </form>
        </details>

        {allowlist.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ppp-charcoal-200 bg-ppp-charcoal-50 px-4 py-6 text-center text-sm text-ppp-charcoal-500">
            No work orders on the allowlist yet.
            {mode === "test_only" && (
              <div className="mt-1 text-[13px] text-amber-800">
                Heads up: mode is Test mode + list is empty ⇒ every customer submission is skipping the Salesforce write.
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-ppp-charcoal-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ppp-charcoal-50 text-[11px] uppercase tracking-wider text-ppp-charcoal-500">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Work order</th>
                  <th className="text-left px-3 py-2 font-semibold">Label</th>
                  <th className="text-left px-3 py-2 font-semibold">Added</th>
                  <th className="px-3 py-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ppp-charcoal-100">
                {allowlist.map((row) => (
                  <tr key={row.workOrderId} className="hover:bg-ppp-charcoal-50/50">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-ppp-charcoal break-all">
                      {row.workOrderId}
                    </td>
                    <td className="px-3 py-2.5 text-[13px] text-ppp-charcoal-700">
                      {row.label ?? <span className="text-ppp-charcoal-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ppp-charcoal-500 whitespace-nowrap">
                      {fmtEt(row.addedAt)}
                      {row.addedBy && (
                        <span className="block text-[11px] text-ppp-charcoal-400">by {row.addedBy}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <form action={removeFromAllowlistAction} className="inline">
                        <input type="hidden" name="work_order_id" value={row.workOrderId} />
                        <button
                          type="submit"
                          className="inline-flex items-center gap-1 text-[12px] font-semibold text-rose-700 hover:text-rose-900 hover:underline px-2 py-1 min-h-[36px]"
                        >
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Help — surfaced when the tables don't exist yet, based on err content */}
      {err.toLowerCase().includes("migration 015") && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-[13px] text-amber-900 space-y-2">
          <div className="font-semibold">Migration 015 not applied?</div>
          <p>
            The <code className="font-mono">customer_form_writeback_settings</code> + <code className="font-mono">customer_form_writeback_allowlist</code> tables need to exist. Paste{" "}
            <code className="font-mono">supabase/migrations/015_customer_form_writeback_gate.sql</code> into the Supabase SQL editor and re-load this page.
          </p>
        </section>
      )}
    </div>
  );
}
