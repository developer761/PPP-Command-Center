import { redirect } from "next/navigation";
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  listTaxJurisdictions,
  createTaxJurisdiction,
  updateTaxJurisdiction,
  deleteTaxJurisdiction,
  type TaxJurisdiction,
} from "@/lib/commercial/tax/db";
import { thouToPct } from "@/lib/commercial/tax/constants";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";

/**
 * Sales-tax jurisdictions admin — the source of truth for the ZIP → tax-rate
 * auto-fill on invoices. Admin-only.
 *
 * IMPORTANT (deliberate): we do NOT hardcode NY tax rates anywhere in code —
 * rates change and are legally sensitive. PPP owns the numbers here. Seeded
 * NY rows land with "verify" flagged so nobody relies on an unconfirmed rate.
 *
 * A jurisdiction = a name + a combined (state + local) rate + the set of ZIP
 * prefixes that fall inside it. The invoice form resolves the project's ZIP to
 * a jurisdiction via longest-prefix match and pre-fills the flat tax %.
 *
 * Mobile: single-column cards; every control ≥44px touch target.
 */

export const dynamic = "force-dynamic";

const BASE = "/commercial/settings/tax";

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  return user;
}

/** Parse a percent string ("8.625", "8.625%") → thousandths-of-a-percent int.
 *  Returns null on empty / non-numeric / out-of-range. */
function parsePctToThou(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.replace(/%/g, "").trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0 || num > 20) return null;
  return Math.round(num * 1000);
}

async function addAction(formData: FormData) {
  "use server";
  const user = await requireAdmin();
  const thou = parsePctToThou(formData.get("rate_pct")?.toString() ?? null);
  if (thou === null) redirect(`${BASE}?error=${encodeURIComponent("Enter a rate between 0% and 20%.")}`);
  const result = await createTaxJurisdiction({
    name: String(formData.get("name") ?? ""),
    combined_rate_thou: thou!,
    zip_prefixes_raw: String(formData.get("zip_prefixes") ?? ""),
    verified: String(formData.get("verified") ?? "") === "on",
    notes: String(formData.get("notes") ?? "") || null,
    actorUserId: user.id,
  });
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  redirect(`${BASE}?ok=added`);
}

async function updateAction(formData: FormData) {
  "use server";
  const user = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`${BASE}?error=invalid`);
  const thou = parsePctToThou(formData.get("rate_pct")?.toString() ?? null);
  if (thou === null) redirect(`${BASE}?error=${encodeURIComponent("Enter a rate between 0% and 20%.")}`);
  const result = await updateTaxJurisdiction(
    id,
    {
      name: String(formData.get("name") ?? ""),
      combined_rate_thou: thou!,
      zip_prefixes_raw: String(formData.get("zip_prefixes") ?? ""),
      // Editing the rate implicitly confirms it — the form's checkbox carries
      // the intent, so a saved-but-unchecked row stays flagged to verify.
      verified: String(formData.get("verified") ?? "") === "on",
      notes: String(formData.get("notes") ?? "") || null,
    },
    user.id
  );
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  redirect(`${BASE}?ok=saved`);
}

async function toggleActiveAction(formData: FormData) {
  "use server";
  const user = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const setTo = String(formData.get("set_to") ?? "");
  if (!id) redirect(`${BASE}?error=invalid`);
  const result = await updateTaxJurisdiction(id, { active: setTo === "active" }, user.id);
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  redirect(`${BASE}?ok=updated`);
}

async function verifyAction(formData: FormData) {
  "use server";
  const user = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`${BASE}?error=invalid`);
  const result = await updateTaxJurisdiction(id, { verified: true }, user.id);
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  redirect(`${BASE}?ok=verified`);
}

async function deleteActionFn(formData: FormData) {
  "use server";
  const user = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`${BASE}?error=invalid`);
  const result = await deleteTaxJurisdiction(id, user.id);
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  redirect(`${BASE}?ok=deleted`);
}

export default async function TaxJurisdictionsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const all = await listTaxJurisdictions();
  const active = all.filter((j) => j.active);
  const inactive = all.filter((j) => !j.active);
  const unverifiedCount = active.filter((j) => !j.verified).length;

  return (
    <div className="space-y-5">
      <Link href="/commercial/settings" className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 min-h-[44px] sm:min-h-[36px]"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>Settings</Link>
            <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">Sales tax by ZIP</h1>
          <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
            {active.length} active
          </span>
          {unverifiedCount > 0 && (
            <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
              {unverifiedCount} to verify
            </span>
          )}
        </div>
        <p className="text-sm text-ppp-charcoal-500 max-w-2xl">
          Configure the jurisdictions PPP works in — a name, the combined (state + local) sales-tax rate, and the ZIP prefixes that fall inside it. When you create an invoice, the platform reads the project&apos;s property ZIP and pre-fills the tax&nbsp;% from here. You can always override the rate on any individual invoice.
        </p>
      </header>

      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[12.5px] text-amber-900 leading-relaxed">
        <strong>These rates are yours to own.</strong> The platform never guesses or hardcodes a tax rate — the seeded NY rows are a <em>starting point only</em> and are flagged &ldquo;verify&rdquo; until you confirm them against the current NYS / county rate. Sales-tax rules (capital-improvement exemptions, rate changes) are a tax matter — confirm with your accountant.
      </div>

      {sp.ok && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-xl px-4 py-2.5 text-sm text-cc-brand-800">
          {sp.ok === "added" && "Jurisdiction added."}
          {sp.ok === "saved" && "Jurisdiction saved."}
          {sp.ok === "updated" && "Status updated."}
          {sp.ok === "verified" && "Rate marked verified."}
          {sp.ok === "deleted" && "Jurisdiction deleted."}
        </div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-sm text-rose-800">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      {/* Add new */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ppp-charcoal mb-3">Add a jurisdiction</h2>
        <form action={addAction} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block sm:col-span-2">
            <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Name</span>
            <input type="text" name="name" required maxLength={120} placeholder="e.g. Nassau County" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-base sm:text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]" />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Combined rate (%)</span>
            <input type="text" name="rate_pct" required inputMode="decimal" placeholder="8.625" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-base sm:text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px] tabular-nums" />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">ZIP prefixes</span>
            <input type="text" name="zip_prefixes" placeholder="115, 116, 1180" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-base sm:text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px] tabular-nums" />
          </label>
          <label className="block sm:col-span-2">
            <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Notes (optional)</span>
            <input type="text" name="notes" maxLength={500} placeholder="What this covers, when the rate was confirmed…" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-base sm:text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[44px]" />
          </label>
          <label className="flex items-center gap-2 sm:col-span-2 text-[12.5px] text-ppp-charcoal-700 select-none">
            <input type="checkbox" name="verified" className="h-4 w-4 rounded border-ppp-charcoal-300 accent-cc-brand-600" />
            I&apos;ve confirmed this is the current rate
          </label>
          <div className="sm:col-span-2 flex justify-end">
            <button type="submit" className="inline-flex items-center px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]">
              Add jurisdiction
            </button>
          </div>
        </form>
        <p className="text-[11px] text-ppp-charcoal-400 mt-2 leading-relaxed">
          <strong>ZIP prefixes</strong> are the leading digits of the ZIPs in this jurisdiction — e.g. <code className="text-ppp-charcoal-600">115</code> matches every 11500–11599 ZIP. Use a longer prefix (<code className="text-ppp-charcoal-600">1180</code>) when only part of a 3-digit band belongs here. Longest match wins if two jurisdictions overlap.
        </p>
      </section>

      {/* Active jurisdictions */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ppp-charcoal mb-3">Active ({active.length})</h2>
        {active.length === 0 ? (
          <p className="text-sm text-ppp-charcoal-500">No active jurisdictions. Add one above — until then, invoices leave the tax&nbsp;% blank for manual entry.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((j) => (
              <li key={j.id} className="border border-ppp-charcoal-100 rounded-lg p-3 sm:p-4">
                <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <div className="font-semibold text-[14px] text-ppp-charcoal truncate">{j.name}</div>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-bold tabular-nums bg-ppp-charcoal-50 text-ppp-charcoal-700 border border-ppp-charcoal-200">
                        {thouToPct(j.combined_rate_thou)}%
                      </span>
                      {j.verified ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">Verified</span>
                      ) : (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-amber-50 text-amber-800 border border-amber-200">Verify rate</span>
                      )}
                    </div>
                    <div className="text-[11.5px] text-ppp-charcoal-600 mt-1">
                      {j.zip_prefixes.length > 0 ? (
                        <span className="tabular-nums">ZIPs: {j.zip_prefixes.join(", ")}</span>
                      ) : (
                        <span className="italic text-ppp-charcoal-400">No ZIP prefixes yet — won&apos;t match any invoice until you add some.</span>
                      )}
                    </div>
                    {j.notes && <div className="text-[11px] text-ppp-charcoal-500 mt-1 whitespace-pre-wrap">{j.notes}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {!j.verified && (
                      <form action={verifyAction}>
                        <input type="hidden" name="id" value={j.id} />
                        <button type="submit" className="text-xs font-medium px-3 py-2 rounded-md border border-emerald-200 text-emerald-800 hover:bg-emerald-50 min-h-[44px]">
                          Mark verified
                        </button>
                      </form>
                    )}
                    <form action={toggleActiveAction}>
                      <input type="hidden" name="id" value={j.id} />
                      <input type="hidden" name="set_to" value="inactive" />
                      <button type="submit" className="text-xs font-medium px-3 py-2 rounded-md border border-amber-200 text-amber-800 hover:bg-amber-50 min-h-[44px]">
                        Deactivate
                      </button>
                    </form>
                  </div>
                </div>
                <EditForm j={j} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {inactive.length > 0 && (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-ppp-charcoal mb-3">Inactive ({inactive.length})</h2>
          <ul className="space-y-2">
            {inactive.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-3 border border-ppp-charcoal-100 rounded-lg p-3">
                <span className="text-sm text-ppp-charcoal-500 truncate">
                  {j.name} · <span className="tabular-nums">{thouToPct(j.combined_rate_thou)}%</span>
                </span>
                <div className="flex gap-2 shrink-0">
                  <form action={toggleActiveAction}>
                    <input type="hidden" name="id" value={j.id} />
                    <input type="hidden" name="set_to" value="active" />
                    <button type="submit" className="text-xs font-medium px-3 py-2 rounded-md border border-cc-brand-200 text-cc-brand-800 hover:bg-cc-brand-50 min-h-[44px]">
                      Reactivate
                    </button>
                  </form>
                  <form action={deleteActionFn}>
                    <input type="hidden" name="id" value={j.id} />
                    <ConfirmSubmitButton
                      message={`Delete "${j.name}" permanently? Inactive jurisdictions never touch new invoices — deactivating is usually enough. This can't be undone.`}
                      className="text-xs font-medium px-3 py-2 rounded-md border border-rose-200 text-rose-800 hover:bg-rose-50 min-h-[44px]"
                    >
                      Delete
                    </ConfirmSubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-[11.5px] text-ppp-charcoal-500">
        Auto-fill shows up when you create an invoice from a{" "}
        <Link href="/commercial/invoices" className="text-cc-brand-700 font-semibold hover:underline">Won opportunity</Link>{" "}
        that has a property ZIP on record. No ZIP or no matching jurisdiction → the tax field stays blank for manual entry.
      </p>
    </div>
  );
}

function EditForm({ j }: { j: TaxJurisdiction }) {
  return (
    <details className="mt-3 group/edit">
      <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] sm:min-h-[28px] select-none">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open/edit:rotate-90">
          <path d="M9 18l6-6-6-6" />
        </svg>
        Edit
      </summary>
      <form action={updateAction} className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 border-t border-ppp-charcoal-100 pt-3">
        <input type="hidden" name="id" value={j.id} />
        <label className="block sm:col-span-2">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Name</span>
          <input type="text" name="name" defaultValue={j.name} required maxLength={120} className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-base sm:text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[40px]" />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Combined rate (%)</span>
          <input type="text" name="rate_pct" defaultValue={thouToPct(j.combined_rate_thou)} required inputMode="decimal" className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-base sm:text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[40px] tabular-nums" />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">ZIP prefixes</span>
          <input type="text" name="zip_prefixes" defaultValue={j.zip_prefixes.join(", ")} className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-base sm:text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[40px] tabular-nums" />
        </label>
        <label className="block sm:col-span-2">
          <span className="block text-[11px] font-semibold text-ppp-charcoal-700 mb-0.5">Notes</span>
          <input type="text" name="notes" defaultValue={j.notes ?? ""} maxLength={500} className="w-full px-2.5 py-2 rounded-md border border-ppp-charcoal-200 text-base sm:text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40 min-h-[40px]" />
        </label>
        <label className="flex items-center gap-2 sm:col-span-2 text-[12.5px] text-ppp-charcoal-700 select-none">
          <input type="checkbox" name="verified" defaultChecked={j.verified} className="h-4 w-4 rounded border-ppp-charcoal-300 accent-cc-brand-600" />
          Rate confirmed / current
        </label>
        <div className="sm:col-span-2 flex justify-end">
          <button type="submit" className="inline-flex items-center px-4 py-2 rounded-md bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[40px]">
            Save
          </button>
        </div>
      </form>
    </details>
  );
}
