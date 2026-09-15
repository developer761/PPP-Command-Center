import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { flashMessage } from "@/lib/commercial/flash";
import { INPUT_CLS, LABEL_CLS, TEXTAREA_CLS } from "@/lib/commercial/form-classnames";
import { InstantSearch } from "@/components/commercial/instant-search";
import { FocusTrapAside } from "@/components/commercial/focus-trap-aside";
import { SubmitButton } from "@/components/commercial/submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import {
  listVendors,
  getVendor,
  createVendor,
  updateVendor,
  setVendorStatus,
  type CommercialVendor,
} from "@/lib/commercial/vendors/db";
import { parseVendorForm, type VendorFields } from "@/lib/commercial/vendors/input";
import { VENDOR_KINDS, VENDOR_KIND_META, isVendorKind, vendorKey, type VendorKind } from "@/lib/commercial/vendors/constants";
import { VENDOR_VIEWS, filterVendorList, parseVendorView, type VendorView } from "@/lib/commercial/vendors/list-view";

/**
 * Settings → Vendors (Katie 2026-09-15).
 *
 * The directory behind the vendor search on every job's Transactions tab: the
 * stores and suppliers Tomco buys from, and the crew payees, labor companies and
 * subs it pays. Seeded from Salesforce (migration 20260915191000).
 *
 * Everyone with Commercial access can LOOK — a PM ringing a supplier needs the
 * number. Admins and account managers edit, the same pair who keep the money
 * desk. Nothing is ever deleted: deactivate hides a vendor from the purchase
 * picker and every past purchase keeps its link.
 *
 * URL-driven, like every Commercial slide-out: ?new=1 / ?edit=<id> open the
 * sheet, ?q= and ?view= drive the list, so a refresh or a shared link lands on
 * exactly what was on screen.
 */

export const dynamic = "force-dynamic";

const BASE = "/commercial/settings/vendors";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SP = {
  q?: string;
  view?: string;
  new?: string;
  edit?: string;
  ok?: string;
  error?: string;
  heads_up?: string;
  draft?: string;
};

const OK_MESSAGES: Record<string, string> = {
  created: "Vendor added. It shows in the vendor search on every job right away.",
  saved: "Vendor saved.",
  deactivated: "Vendor deactivated. It no longer shows in the purchase picker; past purchases keep it.",
  reactivated: "Vendor reactivated — it's back in the purchase picker.",
};

async function viewer(): Promise<{ userId: string; canEdit: boolean }> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  return { userId: user.id, canEdit: role === "admin" || role === "account_manager" };
}

async function requireEditor(): Promise<string> {
  const v = await viewer();
  if (!v.canEdit) redirect(`${BASE}?error=${encodeURIComponent("Only admins and account managers can change vendors.")}`);
  return v.userId;
}

/** Rebuild the list's own query string from a posted value — only the two
 *  params this page owns, so a crafted `return` can't redirect anywhere else. */
function listQs(raw: FormDataEntryValue | null): URLSearchParams {
  const src = new URLSearchParams(typeof raw === "string" ? raw : "");
  const out = new URLSearchParams();
  const q = (src.get("q") ?? "").slice(0, 100);
  const view = parseVendorView(src.get("view"));
  if (q) out.set("q", q);
  if (view !== "all") out.set("view", view);
  return out;
}

function to(qs: URLSearchParams, extra: Record<string, string>): string {
  const p = new URLSearchParams(qs);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `${BASE}?${s}` : BASE;
}

async function saveVendorAction(formData: FormData) {
  "use server";
  const userId = await requireEditor();
  const qs = listQs(formData.get("return"));
  const rawId = String(formData.get("vendor_id") ?? "");
  const id = UUID_RE.test(rawId) ? rawId : null;
  const parsed = parseVendorForm(formData);
  const reopen: Record<string, string> = id ? { edit: id } : { new: "1" };
  if (!parsed.ok) redirect(to(qs, { ...reopen, error: parsed.error }));

  const draft = JSON.stringify(parsed.value).slice(0, 4000);
  if (id) {
    const res = await updateVendor(id, parsed.value, userId);
    if (!res.ok) redirect(to(qs, { edit: id, error: res.error, draft }));
    revalidatePath(BASE);
    redirect(to(qs, { ok: "saved" }));
  }

  // Already in the list — even spelled differently ("sherwin williams" is
  // Sherwin-Williams)? Open THAT one rather than adding a twin or refusing: the
  // person wanted the vendor to exist, and it does. Checked before AND after the
  // insert, so a second tab adding the same name at the same moment lands here too.
  const findExisting = async () => {
    const key = vendorKey(parsed.value.name);
    return (await listVendors()).find((v) => vendorKey(v.name) === key) ?? null;
  };
  const openExisting = (v: CommercialVendor): never =>
    redirect(to(qs, { edit: v.id, heads_up: `"${v.name}" is already in the vendor list${v.status === "inactive" ? " (inactive — reactivate it below)" : ""}. Nothing was added.` }));
  const before = await findExisting();
  if (before) openExisting(before);

  const res = await createVendor(parsed.value, userId);
  if (!res.ok) {
    const existing = await findExisting();
    if (existing) openExisting(existing);
    redirect(to(qs, { new: "1", error: res.error, draft }));
  }
  revalidatePath(BASE);
  redirect(to(qs, { ok: "created" }));
}

async function setStatusAction(formData: FormData) {
  "use server";
  const userId = await requireEditor();
  const qs = listQs(formData.get("return"));
  const id = String(formData.get("vendor_id") ?? "");
  const status = formData.get("status") === "inactive" ? "inactive" : "active";
  if (!UUID_RE.test(id)) redirect(to(qs, {}));
  const res = await setVendorStatus(id, status, userId);
  if (!res.ok) redirect(to(qs, { edit: id, error: res.error }));
  revalidatePath(BASE);
  redirect(to(qs, { ok: status === "inactive" ? "deactivated" : "reactivated" }));
}

/** A rejected save's typed values, so the sheet reopens with them. */
function readDraft(raw: string | undefined): Partial<VendorFields> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Partial<VendorFields>) : null;
  } catch {
    return null;
  }
}

export default async function VendorsSettingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { canEdit } = await viewer();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 100);
  const view = parseVendorView(sp.view);

  const editId = sp.edit && UUID_RE.test(sp.edit) ? sp.edit : null;
  const [vendors, editing] = await Promise.all([listVendors(), editId ? getVendor(editId) : Promise.resolve(null)]);
  const { rows, counts } = filterVendorList(vendors, { q, view });

  const listParams = new URLSearchParams();
  if (q) listParams.set("q", q);
  if (view !== "all") listParams.set("view", view);
  const listHref = listParams.toString() ? `${BASE}?${listParams}` : BASE;
  const hrefWith = (extra: Record<string, string>) => to(listParams, extra);

  const sheetOpen = (sp.new === "1" && canEdit) || !!editing;
  const okMessage = sp.ok ? OK_MESSAGES[sp.ok] : null;
  const errorMessage = flashMessage(sp.error);
  const headsUp = flashMessage(sp.heads_up);
  const totalActive = vendors.filter((v) => v.status === "active").length;

  const viewLabel: Record<VendorView, string> = {
    all: "All",
    retail: VENDOR_KIND_META.retail.label,
    labor: VENDOR_KIND_META.labor.label,
    inactive: "Inactive",
  };

  return (
    <div className="space-y-5 pb-8">
      <Link
        href="/commercial/settings"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 min-h-[44px] sm:min-h-[36px]"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Settings
      </Link>

      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">Vendors</h1>
            <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
              {totalActive} active
            </span>
          </div>
          {canEdit && (
            <Link
              href={hrefWith({ new: "1" })}
              scroll={false}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] shadow-sm shadow-cc-brand-600/30 w-full sm:w-auto"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              Add vendor
            </Link>
          )}
        </div>
        <p className="text-sm text-ppp-charcoal-500 max-w-3xl">
          Stores and suppliers Tomco buys from, and the crew payees, labor companies and subs it pays. This is the list
          behind the vendor search on each job&rsquo;s transactions — labor vendors come up first for labor, stores for
          everything else.
        </p>
      </header>

      {okMessage && (
        <div role="status" className="rounded-xl px-4 py-2.5 text-sm bg-emerald-50 border border-emerald-200 text-emerald-800">
          {okMessage}
        </div>
      )}
      {errorMessage && !sheetOpen && (
        <div role="alert" className="rounded-xl px-4 py-2.5 text-sm bg-rose-50 border border-rose-200 text-rose-800">
          {errorMessage}
        </div>
      )}

      {vendors.length === 0 ? (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">No vendors yet</p>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
            The Salesforce vendor list loads with the vendors migration. Until then, purchases keep taking a typed vendor
            name exactly as before.
          </p>
          {canEdit && (
            <Link
              href={hrefWith({ new: "1" })}
              scroll={false}
              className="mt-4 inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]"
            >
              Add the first vendor
            </Link>
          )}
        </div>
      ) : (
        <>
          {/* Search + view chips */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-3 sm:p-4 space-y-3">
            <form method="GET" action={BASE} role="search">
              {view !== "all" && <input type="hidden" name="view" value={view} />}
              <InstantSearch
                name="q"
                mode="filter"
                defaultValue={q}
                placeholder="Search name, what they sell, contact, phone…"
                ariaLabel="Search vendors"
              />
            </form>
            <nav aria-label="Filter vendors" className="flex flex-wrap gap-2">
              {VENDOR_VIEWS.map((v) => {
                const p = new URLSearchParams();
                if (q) p.set("q", q);
                if (v !== "all") p.set("view", v);
                const active = v === view;
                return (
                  <Link
                    key={v}
                    href={p.toString() ? `${BASE}?${p}` : BASE}
                    scroll={false}
                    aria-current={active ? "page" : undefined}
                    className={`inline-flex items-center gap-1.5 px-3.5 rounded-full border text-[13px] font-semibold min-h-[44px] sm:min-h-[36px] touch-manipulation transition-colors ${
                      active
                        ? "bg-cc-brand-600 border-cc-brand-600 text-white"
                        : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-700 hover:border-ppp-charcoal-300 hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    {viewLabel[v]}
                    <span
                      className={`tabular-nums text-[11.5px] font-bold rounded-full px-1.5 min-w-[20px] text-center ${
                        active ? "bg-white/20 text-white" : "bg-ppp-charcoal-100 text-ppp-charcoal-600"
                      }`}
                    >
                      {counts[v]}
                    </span>
                  </Link>
                );
              })}
            </nav>
          </div>

          {rows.length === 0 ? (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
              <p className="text-sm font-semibold text-ppp-charcoal">
                {q ? `Nothing matches “${q}”${view !== "all" ? ` in ${viewLabel[view]}` : ""}` : `No ${viewLabel[view].toLowerCase()} vendors`}
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {(q || view !== "all") && (
                  <Link href={BASE} scroll={false} className="inline-flex items-center px-3.5 rounded-lg border border-ppp-charcoal-200 text-[13px] font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]">
                    Show all vendors
                  </Link>
                )}
                {canEdit && q && (
                  <Link
                    href={hrefWith({ new: "1", draft: JSON.stringify({ name: q, kind: view === "labor" ? "labor" : "retail" }) })}
                    scroll={false}
                    className="inline-flex items-center px-3.5 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]"
                  >
                    Add “{q}”
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
              {/* Phone: cards. The name opens the vendor; the phone is its own
                  button so a call is one tap, never a mis-tap into the sheet. */}
              <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
                {rows.map((v) => (
                  <li key={v.id} className="flex items-stretch">
                    <Link
                      href={hrefWith({ edit: v.id })}
                      scroll={false}
                      className="flex-1 min-w-0 px-3.5 py-3 min-h-[56px] active:bg-cc-brand-50/60"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[14px] font-semibold text-ppp-charcoal break-words min-w-0">{v.name}</span>
                        <KindBadge kind={v.kind} />
                      </div>
                      <div className="text-[12px] text-ppp-charcoal-500 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        {v.specialty && <span>{v.specialty}</span>}
                        {v.contact_name && <span>{v.contact_name}</span>}
                        {v.city && <span>{v.city}{v.state ? `, ${v.state}` : ""}</span>}
                        <ComplianceBadge vendor={v} />
                      </div>
                    </Link>
                    {v.phone && (
                      <a
                        href={`tel:${v.phone.replace(/[^\d+]/g, "")}`}
                        aria-label={`Call ${v.name}`}
                        className="shrink-0 w-14 flex items-center justify-center border-l border-ppp-charcoal-100 text-cc-brand-700 active:bg-cc-brand-50"
                      >
                        <IconPhone />
                      </a>
                    )}
                  </li>
                ))}
              </ul>

              {/* Desktop: table. */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-ppp-charcoal-100 bg-ppp-charcoal-50/60 text-left">
                      <th scope="col" className="px-4 py-2.5 font-bold uppercase tracking-wider text-[10.5px] text-ppp-charcoal-500">Vendor</th>
                      <th scope="col" className="px-3 py-2.5 font-bold uppercase tracking-wider text-[10.5px] text-ppp-charcoal-500">Kind</th>
                      <th scope="col" className="px-3 py-2.5 font-bold uppercase tracking-wider text-[10.5px] text-ppp-charcoal-500">Contact</th>
                      <th scope="col" className="px-3 py-2.5 font-bold uppercase tracking-wider text-[10.5px] text-ppp-charcoal-500">Location</th>
                      <th scope="col" className="px-3 py-2.5 font-bold uppercase tracking-wider text-[10.5px] text-ppp-charcoal-500">Payment</th>
                      <th scope="col" className="px-3 py-2.5"><span className="sr-only">Open</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ppp-charcoal-100">
                    {rows.map((v) => (
                      <tr key={v.id} className="group hover:bg-cc-brand-50/40 transition-colors align-top">
                        <td className="px-4 py-2.5 min-w-[200px]">
                          <Link href={hrefWith({ edit: v.id })} scroll={false} className="font-semibold text-ppp-charcoal group-hover:text-cc-brand-800 hover:underline">
                            {v.name}
                          </Link>
                          {v.specialty && <div className="text-[12px] text-ppp-charcoal-500 mt-0.5">{v.specialty}</div>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex flex-col items-start gap-1">
                            <KindBadge kind={v.kind} />
                            <ComplianceBadge vendor={v} />
                          </div>
                        </td>
                        <td className="px-3 py-2.5 min-w-[180px]">
                          {v.contact_name && <div className="text-ppp-charcoal-700">{v.contact_name}</div>}
                          {v.phone && (
                            <a href={`tel:${v.phone.replace(/[^\d+]/g, "")}`} className="block text-ppp-charcoal-700 hover:text-cc-brand-700 tabular-nums whitespace-nowrap">
                              {v.phone}
                            </a>
                          )}
                          {v.email && (
                            <a href={`mailto:${v.email}`} className="block text-ppp-charcoal-500 hover:text-cc-brand-700 break-all">
                              {v.email}
                            </a>
                          )}
                          {!v.contact_name && !v.phone && !v.email && <span className="text-ppp-charcoal-400">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-ppp-charcoal-600">
                          {v.city || v.state ? [v.city, v.state].filter(Boolean).join(", ") : <span className="text-ppp-charcoal-400">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-ppp-charcoal-600">
                          {v.payment_terms || v.preferred_payment ? (
                            [v.preferred_payment, v.payment_terms].filter(Boolean).join(" · ")
                          ) : (
                            <span className="text-ppp-charcoal-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Link
                            href={hrefWith({ edit: v.id })}
                            scroll={false}
                            className="inline-flex items-center px-3 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[36px]"
                          >
                            {canEdit ? "Edit" : "View"}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {!canEdit && (
            <p className="text-[12px] text-ppp-charcoal-500">
              You can look vendors up. Admins and account managers keep the list up to date — or add a new one straight from
              a job&rsquo;s transactions.
            </p>
          )}
        </>
      )}

      {sheetOpen && (
        <VendorSheet
          vendor={editing}
          canEdit={canEdit}
          closeHref={listHref}
          returnQs={listParams.toString()}
          error={errorMessage}
          headsUp={headsUp}
          draft={readDraft(sp.draft)}
        />
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const k: VendorKind = isVendorKind(kind) ? kind : "retail";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-bold uppercase tracking-wide border whitespace-nowrap ${
        k === "labor" ? "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" : "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200"
      }`}
    >
      {VENDOR_KIND_META[k].label}
    </span>
  );
}

/** Labor vendors only: is the W-9 on file? Plus "Inactive" on any vendor. */
function ComplianceBadge({ vendor }: { vendor: CommercialVendor }) {
  return (
    <>
      {vendor.status === "inactive" && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold border bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200 whitespace-nowrap">
          Inactive
        </span>
      )}
      {vendor.kind === "labor" &&
        (vendor.w9_on_file ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold border bg-emerald-50 text-emerald-800 border-emerald-200 whitespace-nowrap">
            W-9 on file
          </span>
        ) : (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold border bg-amber-50 text-amber-800 border-amber-200 whitespace-nowrap">
            No W-9
          </span>
        ))}
    </>
  );
}

function VendorSheet({
  vendor,
  canEdit,
  closeHref,
  returnQs,
  error,
  headsUp,
  draft,
}: {
  vendor: CommercialVendor | null;
  canEdit: boolean;
  closeHref: string;
  returnQs: string;
  error: string | null;
  headsUp: string | null;
  draft: Partial<VendorFields> | null;
}) {
  const isNew = !vendor;
  // A rejected save reopens with what was typed; otherwise the stored row.
  const val = <K extends keyof VendorFields>(k: K): VendorFields[K] | undefined =>
    (draft && k in draft ? draft[k] : vendor?.[k]) as VendorFields[K] | undefined;
  const str = (k: keyof VendorFields) => {
    const v = val(k);
    return typeof v === "string" ? v : "";
  };
  const kind: VendorKind = isVendorKind(val("kind")) ? (val("kind") as VendorKind) : "retail";
  const title = isNew ? "Add vendor" : canEdit ? "Edit vendor" : vendor!.name;

  return (
    <>
      <Link href={closeHref} scroll={false} aria-label="Close vendor panel" className="fixed inset-x-0 top-0 h-dvh-full z-40 bg-ppp-navy-900/40 backdrop-blur-sm" />
      <FocusTrapAside
        closeHref={closeHref}
        id="vendor-sheet"
        ariaLabelledBy="vendor-sheet-title"
        className="fixed right-0 top-0 h-dvh-full z-50 w-full sm:max-w-lg bg-surface shadow-2xl flex flex-col"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-ppp-charcoal-100">
          <div className="min-w-0">
            <h2 id="vendor-sheet-title" className="text-base font-bold text-ppp-charcoal break-words">{title}</h2>
            <p className="text-xs text-ppp-charcoal-500 mt-0.5">
              {isNew
                ? "Only the name is required — add what you know, fill the rest in later."
                : vendor!.status === "inactive"
                  ? "Inactive — hidden from the purchase picker."
                  : VENDOR_KIND_META[vendor!.kind].blurb}
            </p>
          </div>
          <Link
            href={closeHref}
            scroll={false}
            aria-label="Close"
            className="-m-2 text-ppp-charcoal-400 hover:text-ppp-charcoal touch-manipulation min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6L6 18 M6 6l12 12" />
            </svg>
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-4">
          {error && (
            <div role="alert" className="rounded-lg px-3 py-2 text-[13px] bg-rose-50 border border-rose-200 text-rose-800">{error}</div>
          )}
          {headsUp && (
            <div role="status" className="rounded-lg px-3 py-2 text-[13px] bg-amber-50 border border-amber-200 text-amber-900">{headsUp}</div>
          )}

          {canEdit ? (
            <form id="vendor-form" action={saveVendorAction} className="space-y-4">
              <input type="hidden" name="return" value={returnQs} />
              {vendor && <input type="hidden" name="vendor_id" value={vendor.id} />}

              <div>
                <label htmlFor="vendor-name" className={LABEL_CLS}>Name</label>
                <input id="vendor-name" name="name" required maxLength={200} defaultValue={str("name")} placeholder="e.g. Sherwin-Williams, Tomco Labor - Greg" className={INPUT_CLS} autoComplete="off" />
              </div>

              <fieldset>
                <legend className={LABEL_CLS}>Kind</legend>
                <div className="grid grid-cols-2 gap-2">
                  {VENDOR_KINDS.map((k) => (
                    <label
                      key={k}
                      className="relative flex flex-col gap-0.5 rounded-xl border border-ppp-charcoal-200 px-3 py-2.5 min-h-[44px] cursor-pointer touch-manipulation has-[:checked]:border-cc-brand-600 has-[:checked]:bg-cc-brand-50 has-[:checked]:ring-2 has-[:checked]:ring-cc-brand-600/20"
                    >
                      <span className="flex items-center gap-2">
                        <input type="radio" name="kind" value={k} defaultChecked={kind === k} className="h-4 w-4 accent-cc-brand-600" />
                        <span className="text-[13.5px] font-semibold text-ppp-charcoal">{VENDOR_KIND_META[k].label}</span>
                      </span>
                      <span className="text-[11.5px] text-ppp-charcoal-500 leading-snug">
                        {k === "labor" ? "Crew payees, labor companies, subs" : "Stores, suppliers, rentals"}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <Field id="vendor-specialty" name="specialty" label="What they sell or do" value={str("specialty")} placeholder="Paint, Equipment Rental, Wallcovering…" max={120} />

              <SectionLabel>Contact</SectionLabel>
              <Field id="vendor-contact" name="contact_name" label="Contact name" value={str("contact_name")} max={120} autoComplete="off" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field id="vendor-phone" name="phone" label="Phone" value={str("phone")} type="tel" inputMode="tel" placeholder="(631) 555-1234" max={40} autoComplete="off" />
                <Field id="vendor-email" name="email" label="Email" value={str("email")} type="email" inputMode="email" max={200} autoComplete="off" />
              </div>
              <Field id="vendor-website" name="website" label="Website" value={str("website")} inputMode="url" max={200} autoComplete="off" />

              <SectionLabel>Address</SectionLabel>
              <Field id="vendor-address" name="address_line1" label="Street" value={str("address_line1")} max={200} autoComplete="off" />
              <div className="grid grid-cols-[1fr_5rem_6.5rem] gap-2">
                <Field id="vendor-city" name="city" label="City" value={str("city")} max={80} autoComplete="off" />
                <Field id="vendor-state" name="state" label="State" value={str("state")} max={40} placeholder="NY" autoComplete="off" />
                <Field id="vendor-zip" name="zip" label="Zip" value={str("zip")} inputMode="numeric" max={20} autoComplete="off" />
              </div>

              <SectionLabel>Paying them</SectionLabel>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field id="vendor-terms" name="payment_terms" label="Payment terms" value={str("payment_terms")} placeholder="Upon Receipt, Net 30…" max={80} />
                <Field id="vendor-pay" name="preferred_payment" label="Preferred payment" value={str("preferred_payment")} placeholder="ACH, Check, Card…" max={80} />
              </div>
              <label className="flex items-center gap-3 rounded-xl border border-ppp-charcoal-200 px-3 py-2 min-h-[44px] cursor-pointer touch-manipulation has-[:checked]:border-emerald-300 has-[:checked]:bg-emerald-50">
                <input type="checkbox" name="w9_on_file" defaultChecked={draft && "w9_on_file" in draft ? !!draft.w9_on_file : !!vendor?.w9_on_file} className="h-4 w-4 accent-cc-brand-600 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-ppp-charcoal">W-9 on file</span>
                  <span className="block text-[11.5px] text-ppp-charcoal-500">Needed before paying a labor vendor.</span>
                </span>
              </label>
              <Field id="vendor-compliance" name="compliance_status" label="Compliance status" value={str("compliance_status")} placeholder="e.g. COI current through 2027" max={80} />

              <div>
                <label htmlFor="vendor-notes" className={LABEL_CLS}>Notes</label>
                <textarea id="vendor-notes" name="notes" rows={3} maxLength={2000} defaultValue={str("notes")} className={TEXTAREA_CLS} placeholder="Account numbers, pickup hours, who to ask for…" />
              </div>
            </form>
          ) : (
            <ReadOnlyVendor vendor={vendor!} />
          )}

          {vendor && vendor.sf_account_ids.length > 0 && (
            <p className="text-[11.5px] text-ppp-charcoal-400 break-all">
              Salesforce account{vendor.sf_account_ids.length === 1 ? "" : "s"}: {vendor.sf_account_ids.join(", ")}
            </p>
          )}

          {/* Deactivate / reactivate — its own form, never nested in the save form. */}
          {canEdit && vendor && (
            <form action={setStatusAction} className="border-t border-ppp-charcoal-100 pt-4">
              <input type="hidden" name="return" value={returnQs} />
              <input type="hidden" name="vendor_id" value={vendor.id} />
              {vendor.status === "active" ? (
                <>
                  <input type="hidden" name="status" value="inactive" />
                  <ConfirmSubmitButton
                    message={`Deactivate ${vendor.name}? It disappears from the purchase picker. Past purchases keep it, and you can reactivate it any time.`}
                    pendingLabel="Deactivating…"
                    className="inline-flex items-center px-3.5 rounded-lg border border-ppp-charcoal-200 text-[13px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[44px] touch-manipulation"
                  >
                    Deactivate vendor
                  </ConfirmSubmitButton>
                  <p className="text-[11.5px] text-ppp-charcoal-500 mt-1.5">Vendors are never deleted, so no purchase loses its vendor.</p>
                </>
              ) : (
                <>
                  <input type="hidden" name="status" value="active" />
                  <SubmitButton pendingLabel="Reactivating…" className="inline-flex items-center px-3.5 rounded-lg border border-emerald-300 text-[13px] font-semibold text-emerald-800 hover:bg-emerald-50 min-h-[44px] touch-manipulation">
                    Reactivate vendor
                  </SubmitButton>
                </>
              )}
            </form>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/50">
          <Link href={closeHref} scroll={false} className="inline-flex items-center justify-center px-3.5 rounded-lg text-sm font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-100 min-h-[44px]">
            {canEdit ? "Cancel" : "Close"}
          </Link>
          {canEdit && (
            <SubmitButton form="vendor-form" pendingLabel="Saving…" className="inline-flex items-center justify-center px-5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] shadow-sm shadow-cc-brand-600/30">
              {isNew ? "Add vendor" : "Save"}
            </SubmitButton>
          )}
        </div>
      </FocusTrapAside>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-500 pt-1">{children}</h3>;
}

function Field({
  id,
  name,
  label,
  value,
  placeholder,
  max,
  type = "text",
  inputMode,
  autoComplete,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  placeholder?: string;
  max: number;
  type?: "text" | "tel" | "email";
  inputMode?: "tel" | "email" | "url" | "numeric";
  autoComplete?: string;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL_CLS}>{label}</label>
      <input id={id} name={name} type={type} inputMode={inputMode} maxLength={max} defaultValue={value} placeholder={placeholder} autoComplete={autoComplete} className={INPUT_CLS} />
    </div>
  );
}

function ReadOnlyVendor({ vendor }: { vendor: CommercialVendor }) {
  const rows: [string, React.ReactNode][] = [
    ["Kind", VENDOR_KIND_META[vendor.kind].label],
    ["What they sell or do", vendor.specialty],
    ["Contact", vendor.contact_name],
    ["Phone", vendor.phone ? <a href={`tel:${vendor.phone.replace(/[^\d+]/g, "")}`} className="text-cc-brand-700 hover:underline">{vendor.phone}</a> : null],
    ["Email", vendor.email ? <a href={`mailto:${vendor.email}`} className="text-cc-brand-700 hover:underline break-all">{vendor.email}</a> : null],
    ["Website", vendor.website],
    ["Address", [vendor.address_line1, [vendor.city, vendor.state].filter(Boolean).join(", "), vendor.zip].filter(Boolean).join(" · ") || null],
    ["Payment", [vendor.preferred_payment, vendor.payment_terms].filter(Boolean).join(" · ") || null],
    ["W-9", vendor.kind === "labor" ? (vendor.w9_on_file ? "On file" : "Not on file") : null],
    ["Compliance", vendor.compliance_status],
    ["Notes", vendor.notes],
  ];
  return (
    <dl className="divide-y divide-ppp-charcoal-100 rounded-xl border border-ppp-charcoal-100">
      {rows
        .filter(([, v]) => v !== null && v !== "")
        .map(([k, v]) => (
          <div key={k} className="px-3.5 py-2.5 grid grid-cols-[7.5rem_1fr] gap-3">
            <dt className="text-[12px] font-semibold text-ppp-charcoal-500">{k}</dt>
            <dd className="text-[13px] text-ppp-charcoal whitespace-pre-wrap break-words min-w-0">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function IconPhone() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}
