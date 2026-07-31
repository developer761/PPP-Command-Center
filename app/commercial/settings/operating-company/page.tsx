import { redirect } from "next/navigation";
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { revalidatePath } from "next/cache";
import { getOperatingCompany, updateOperatingCompany } from "@/lib/commercial/operating-company/db";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { BrandAssetUpload } from "@/components/commercial/brand-asset-upload";

/**
 * Operating Company — the single identity that flows into every generated
 * document (proposals, invoices, AIA, transmittals, warranty, work order,
 * statement). Edit once here; every PDF picks it up. Admin-only.
 *
 * Logo + signature image upload land in the next step (brand-assets bucket).
 * Mobile: single column, ≥44px controls.
 */

export const dynamic = "force-dynamic";

const BASE = "/commercial/settings/operating-company";

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

async function saveAction(formData: FormData) {
  "use server";
  const user = await requireAdmin();
  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : "";
  };
  const res = await updateOperatingCompany(
    {
      name: get("name"),
      legal_name: get("legal_name"),
      address_line1: get("address_line1"),
      address_line2: get("address_line2"),
      city: get("city"),
      state: get("state"),
      zip: get("zip"),
      phone: get("phone"),
      fax: get("fax"),
      email: get("email"),
      website: get("website"),
    },
    user.id,
  );
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  revalidatePath(BASE);
  redirect(`${BASE}?ok=1`);
}

export default async function OperatingCompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const c = await getOperatingCompany();

  const Field = ({ id, label, value, placeholder, type = "text", full = false }: { id: string; label: string; value: string | null; placeholder?: string; type?: string; full?: boolean }) => (
    <div className={full ? "sm:col-span-2" : ""}>
      <label htmlFor={id} className={LABEL_CLS}>{label}</label>
      <input id={id} name={id} type={type} defaultValue={value ?? ""} placeholder={placeholder} className={INPUT_CLS} />
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div>
        <Link href="/commercial/settings" className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 mb-2 min-h-[36px]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
          Settings
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">Operating Company</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">This identity appears on every generated document — proposals, invoices, AIA billing, transmittals, warranties, work orders and statements. Edit it once here.</p>
      </div>

      {sp.ok && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-[13px] text-emerald-800">Saved. New documents will use this identity.</div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">{decodeURIComponent(sp.error)}</div>
      )}

      <form action={saveAction} className="space-y-5">
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <h2 className="text-[13px] font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" /> Identity
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field id="name" label="Display name" value={c.name} placeholder="Tomco Painting" full />
            <Field id="legal_name" label="Legal name (optional)" value={c.legal_name} placeholder="Tomco Painting" full />
          </div>
        </section>

        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <h2 className="text-[13px] font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" /> Address
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field id="address_line1" label="Street" value={c.address_line1} placeholder="77 Windsor Place, Ste. 13" full />
            <Field id="address_line2" label="Street line 2 (optional)" value={c.address_line2} full />
            <Field id="city" label="City" value={c.city} placeholder="Central Islip" />
            <div className="grid grid-cols-2 gap-3">
              <Field id="state" label="State" value={c.state} placeholder="NY" />
              <Field id="zip" label="ZIP" value={c.zip} placeholder="11722" />
            </div>
          </div>
        </section>

        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <h2 className="text-[13px] font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" /> Contact
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field id="phone" label="Phone" value={c.phone} placeholder="631.582.2770" type="tel" />
            <Field id="fax" label="Fax" value={c.fax} placeholder="631.582.2771" type="tel" />
            <Field id="email" label="Email" value={c.email} placeholder="office@tomcopainting.com" type="email" />
            <Field id="website" label="Website" value={c.website} placeholder="www.tomcopainting.com" />
          </div>
        </section>

        <div className="flex justify-end">
          <PendingSubmitButton className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation" pendingLabel="Saving…">
            Save company identity
          </PendingSubmitButton>
        </div>
      </form>

      {/* Branding assets — self-submitting uploaders (outside the identity form
          so they don't nest). Render on every generated PDF. */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <h2 className="text-[13px] font-bold text-ppp-charcoal mb-1 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" /> Branding
        </h2>
        <p className="text-[11.5px] text-ppp-charcoal-500 mb-3">The logo appears on every generated PDF (proposals, invoices, transmittals, warranties, work orders). The signature is what &ldquo;Tap to sign&rdquo; drops onto documents that need a signature.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <BrandAssetUpload kind="logo" label="Logo / letterhead" hint="PNG, JPEG or WEBP · max 5 MB. Transparent PNG works best." hasAsset={!!c.logo_asset_key} />
          <BrandAssetUpload kind="signature" label="Signature image" hint="PNG/JPEG of an authorized signature (e.g. Brendan's), used by Tap to sign." hasAsset={!!c.signature_asset_key} />
        </div>
      </section>
    </div>
  );
}
