import { redirect } from "next/navigation";
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { getOperatingCompany, updateOperatingCompany } from "@/lib/commercial/operating-company/db";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { BrandAssetUpload } from "@/components/commercial/brand-asset-upload";
import { SignaturePad } from "@/components/commercial/signature-pad";

/**
 * Operating Company — the single identity that flows into the generated
 * documents (invoices, AIA, transmittals, warranty, work order, statement).
 * The customer PROPOSAL is the deliberate exception: it renders Tomco's fixed
 * 1:1 letterhead (bundled logo + matched format), not this identity. Edit once
 * here; those PDFs pick it up. (fax + legal_name are stored for future use and
 * not yet placed on any document.)
 *
 *  * Mobile: single column, ≥44px controls.
 */

export const dynamic = "force-dynamic";

const BASE = "/commercial/settings/operating-company";

async function requireCommercialUser() {
  // Roles are open for now (Karan 2026-07-31) — any commercial user can manage
  // the operating company (so e.g. Brendan can set up his own signature).
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user;
}

async function saveAction(formData: FormData) {
  "use server";
  const user = await requireCommercialUser();
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
      signature_name: get("signature_name"),
      signature_title: get("signature_title"),
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
  await requireCommercialUser();
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
        <Link href="/commercial/settings" className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 mb-2 min-h-[44px] sm:min-h-[36px]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
          Settings
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">Operating Company</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">This identity appears on your generated documents — invoices, AIA billing, transmittals, warranties, work orders and statements. (The GC <strong>proposal</strong> uses Tomco&apos;s fixed 1:1 letterhead and isn&apos;t driven by this identity.) Edit it once here.</p>
      </div>

      {sp.ok && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-[13px] text-emerald-800">Saved. New documents will use this identity.</div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">{sp.error}</div>
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
        <p className="text-[11.5px] text-ppp-charcoal-500 mb-3">The logo appears on your generated PDFs (invoices, transmittals, warranties, work orders). The GC proposal keeps Tomco&apos;s fixed letterhead. The signature is what &ldquo;Tap to sign&rdquo; drops onto documents that need a signature.</p>
        <div className="grid grid-cols-1 gap-3">
          <BrandAssetUpload kind="logo" label="Logo / letterhead" hint="PNG, JPEG or WEBP · max 5 MB. Transparent PNG works best." hasAsset={!!c.logo_asset_key} />

          <div className="rounded-lg border border-ppp-charcoal-100 bg-surface p-3.5">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[12px] font-semibold text-ppp-charcoal">Signature</span>
              {c.signature_asset_key && (
                <span className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wide text-emerald-700">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                  On file
                </span>
              )}
            </div>
            {/* Katie's captured Form of Warranty signs "Brendan Dwyer, VP" —
                a signature image over a company name doesn't say WHO stood
                behind a twelve-month guarantee. Both optional: left blank, the
                block keeps reading "Authorized signature". */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <Field id="signature_name" label="Signs as (name)" value={c.signature_name} placeholder="Brendan Dwyer" />
              <Field id="signature_title" label="Title" value={c.signature_title} placeholder="VP" />
            </div>
            <SignaturePad hasSignature={!!c.signature_asset_key} />
            <details className="mt-3">
              <summary className="cursor-pointer list-none text-[11.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[36px] inline-flex items-center">Or upload a signature image / remove it</summary>
              <div className="mt-2">
                <BrandAssetUpload kind="signature" label="Signature image" hint="PNG/JPEG of a scanned signature — used the same way as a drawn one." hasAsset={!!c.signature_asset_key} />
              </div>
            </details>
          </div>
        </div>
      </section>
    </div>
  );
}
