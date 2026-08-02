import { redirect } from "next/navigation";
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { getOperatingCompany, updateOperatingCompany } from "@/lib/commercial/operating-company/db";
import { INPUT_CLS, LABEL_CLS, TEXTAREA_CLS } from "@/lib/commercial/form-classnames";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { BrandAssetUpload } from "@/components/commercial/brand-asset-upload";
import { SignaturePad } from "@/components/commercial/signature-pad";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getCommercialRoles } from "@/lib/commercial/rbac";

/**
 * Operating Company — the single identity that flows into every generated
 * document (proposals, invoices, AIA, transmittals, warranty, work order,
 * statement). Edit once here; every PDF picks it up.
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

/** R1d: is this user an admin? Admins alone manage the proposal approver list. */
async function isViewerAdmin(userId: string): Promise<boolean> {
  const profile = await getProfileByUserId(userId);
  const email = (profile as { email?: string | null } | null)?.email ?? null;
  if (email && isAdminEmail(email)) return true;
  try {
    const roles = await getCommercialRoles(userId);
    return roles.hasAdminRole;
  } catch {
    return false;
  }
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
    },
    user.id,
  );
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  revalidatePath(BASE);
  redirect(`${BASE}?ok=1`);
}

/** R1d: admin-only — set who (besides admins) can approve proposals. */
async function saveApproversAction(formData: FormData) {
  "use server";
  const user = await requireCommercialUser();
  if (!(await isViewerAdmin(user.id))) {
    redirect(`${BASE}?error=${encodeURIComponent("Only an admin can change the proposal approvers.")}`);
  }
  const raw = formData.get("approver_emails");
  const text = typeof raw === "string" ? raw : "";
  // Accept newline- OR comma-separated; normalize + dedupe happens in the db layer.
  const emails = text
    .split(/[\n,]/)
    .map((e) => e.trim())
    .filter(Boolean);
  const res = await updateOperatingCompany({ approver_emails: emails }, user.id);
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  revalidatePath(BASE);
  redirect(`${BASE}?approvers=1`);
}

export default async function OperatingCompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; approvers?: string }>;
}) {
  const viewer = await requireCommercialUser();
  const sp = await searchParams;
  const c = await getOperatingCompany();
  const viewerIsAdmin = await isViewerAdmin(viewer.id);

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
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">This identity appears on every generated document — proposals, invoices, AIA billing, transmittals, warranties, work orders and statements. Edit it once here.</p>
      </div>

      {sp.ok && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-[13px] text-emerald-800">Saved. New documents will use this identity.</div>
      )}
      {sp.approvers && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-[13px] text-emerald-800">Proposal approvers updated.</div>
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

      {/* R1d — proposal approvers. Admins can always approve; this list adds
          named non-admins (Brendan, Stephanie). Admin-gated editing. */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <h2 className="text-[13px] font-bold text-ppp-charcoal mb-1 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" /> Proposal approvers
        </h2>
        <p className="text-[11.5px] text-ppp-charcoal-500 mb-3">
          A proposal must be <strong>approved</strong> before it can be sent to a GC. Admins can always approve. Add the emails of anyone else who should be able to approve (e.g. Brendan, Stephanie) — one per line.
        </p>
        {viewerIsAdmin ? (
          <form action={saveApproversAction} className="space-y-3">
            <div>
              <label htmlFor="approver_emails" className={LABEL_CLS}>Approver emails</label>
              <textarea
                id="approver_emails"
                name="approver_emails"
                rows={4}
                defaultValue={(c.approver_emails ?? []).join("\n")}
                placeholder={"brendan@tomcopainting.com\nstephanie@tomcopainting.com"}
                className={TEXTAREA_CLS}
              />
              <p className="text-[10.5px] text-ppp-charcoal-400 mt-1">One email per line. These users see the Approve / Request-changes buttons on any pending proposal. Admins already have this ability.</p>
            </div>
            <div className="flex justify-end">
              <PendingSubmitButton className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation" pendingLabel="Saving…">
                Save approvers
              </PendingSubmitButton>
            </div>
          </form>
        ) : (
          <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/50 p-3.5">
            {(c.approver_emails ?? []).length > 0 ? (
              <ul className="text-[12.5px] text-ppp-charcoal-700 space-y-0.5">
                {(c.approver_emails ?? []).map((e) => (
                  <li key={e} className="font-medium">{e}</li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-ppp-charcoal-500">No named approvers yet — only admins can approve proposals. Ask an admin to add approvers here.</p>
            )}
            <p className="text-[10.5px] text-ppp-charcoal-400 mt-2">Only an admin can change this list.</p>
          </div>
        )}
      </section>
    </div>
  );
}
