import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { flashMessage } from "@/lib/commercial/flash";
import { UUID_RE } from "@/lib/commercial/uuid";
import { INPUT_CLS, LABEL_CLS, TEXTAREA_CLS } from "@/lib/commercial/form-classnames";
import { SearchableSelect } from "@/components/commercial/searchable-select";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { SubmitButton } from "@/components/commercial/submit-button";
import { FolderGlyph, FOLDER_ICON_LABEL, PathIcon } from "@/components/commercial/reports/folder-glyph";
import { REPORTS, REPORT_GROUPS, isReportKey, reportDef } from "@/lib/commercial/reports/registry";
import {
  FOLDER_ICONS,
  listSharedFoldersForAdmin,
  listFolderPeople,
  createFolder,
  updateFolder,
  deleteFolder,
  moveFolder,
  setFolderReports,
  moveReportInFolder,
  addFolderMember,
  removeFolderMember,
} from "@/lib/commercial/reports/folders-db";

export const metadata = { title: "Report folders" };

export const dynamic = "force-dynamic";

const BASE = "/commercial/settings/report-folders";
const SHARED = { kind: "shared" as const };

/**
 * Settings → Report folders (Katie 2026-09-15).
 *
 * Team folders decide who sees which reports: a non-admin sees exactly the
 * reports in the folders they're in. Admins see every report regardless, so
 * this page says so beside any admin in a folder — otherwise "why can Brendan
 * still see Labor?" has no answer on screen.
 */

async function requireAdmin(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin") redirect("/commercial");
  return user.id;
}

function done(folderId: string | null, extra: Record<string, string> = {}): never {
  const qs = new URLSearchParams();
  if (folderId) qs.set("folder", folderId);
  for (const [k, v] of Object.entries(extra)) qs.set(k, v);
  revalidatePath(BASE);
  // The Reports index + tab bar read the same folders.
  revalidatePath("/commercial/reports", "layout");
  const s = qs.toString();
  redirect(s ? `${BASE}?${s}` : BASE);
}

function idFrom(formData: FormData, name = "folder_id"): string | null {
  const v = String(formData.get(name) ?? "");
  return UUID_RE.test(v) ? v : null;
}

async function createFolderAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const res = await createFolder(
    { name: String(formData.get("name") ?? ""), icon: String(formData.get("icon") ?? "folder") },
    SHARED,
    uid
  );
  if (!res.ok) done(null, { error: res.error });
  done(res.id, { saved: "Folder made. Pick its reports and people below." });
}

async function updateFolderAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = idFrom(formData);
  if (!id) done(null);
  const res = await updateFolder(
    id,
    {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      icon: String(formData.get("icon") ?? ""),
    },
    SHARED,
    uid
  );
  done(id, res.ok ? { saved: "Details saved." } : { error: res.error });
}

async function deleteFolderAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = idFrom(formData);
  if (!id) done(null);
  const res = await deleteFolder(id, SHARED, uid);
  done(res.ok ? null : id, res.ok ? { saved: `Deleted “${res.name}”. Its people no longer see its reports through it.` } : { error: res.error });
}

async function moveFolderAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = idFrom(formData);
  if (!id) done(null);
  const res = await moveFolder(id, String(formData.get("dir")) === "up" ? "up" : "down", SHARED, uid);
  done(idFrom(formData, "selected") ?? id, res.ok ? {} : { error: res.error });
}

async function setReportsAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = idFrom(formData);
  if (!id) done(null);
  const wanted = formData.getAll("report_key").map(String).filter(isReportKey);
  const res = await setFolderReports(id, wanted, SHARED, uid);
  done(id, res.ok ? { saved: `Reports saved — ${wanted.length} in this folder.` } : { error: res.error });
}

async function moveReportAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = idFrom(formData);
  const key = String(formData.get("report_key") ?? "");
  if (!id || !isReportKey(key)) done(id);
  const res = await moveReportInFolder(id, key, String(formData.get("dir")) === "up" ? "up" : "down", SHARED, uid);
  done(id, res.ok ? {} : { error: res.error });
}

async function addMemberAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = idFrom(formData);
  const userId = idFrom(formData, "user_id");
  if (!id) done(null);
  if (!userId) done(id, { error: "Pick a person to add." });
  const res = await addFolderMember(id, userId, uid);
  if (!res.ok) done(id, { error: res.error });
  const p = res.person;
  const heads =
    p.role === "admin"
      ? ` ${p.name} is an admin, so they already see every report — this records the grouping.`
      : !p.hasCommercial
        ? ` ${p.name} doesn't have Commercial access yet, so they won't see anything until it's turned on in Access & Users.`
        : "";
  done(id, { saved: `Added ${p.name}.${heads}` });
}

async function removeMemberAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = idFrom(formData);
  const memberId = idFrom(formData, "member_id");
  if (!memberId) done(id);
  const res = await removeFolderMember(memberId, uid);
  done(id, res.ok ? { saved: "Removed from the folder." } : { error: res.error });
}

export default async function ReportFoldersSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; error?: string; saved?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const [list, people] = await Promise.all([listSharedFoldersForAdmin(), listFolderPeople()]);
  const folders = list.ok ? list.folders : [];
  const selected = folders.find((f) => f.id === sp.folder) ?? null;
  const memberIds = new Set((selected?.members ?? []).map((m) => m.user_id));
  const addable = people
    .filter((p) => !memberIds.has(p.user_id))
    .map((p) => ({
      value: p.user_id,
      label: p.name,
      hint: [p.email, p.role === "admin" ? "Admin — sees every report" : null, p.hasCommercial ? null : "No Commercial access"]
        .filter(Boolean)
        .join(" · "),
    }));
  const error = flashMessage(sp.error);
  const saved = flashMessage(sp.saved);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
      <div className="mb-1">
        <Link href="/commercial/settings" className="inline-flex items-center min-h-[44px] text-[12px] font-semibold text-cc-brand-700 hover:underline">← Settings</Link>
      </div>
      <div className="flex items-end justify-between gap-3 flex-wrap mb-5">
        <div className="min-w-0">
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Report folders</h1>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1.5 max-w-2xl leading-relaxed">
            Team folders decide who sees which reports. Someone who isn&rsquo;t an admin sees exactly the reports in the folders
            they&rsquo;re in — nothing else. Admins always see every report. Anyone can also make their own folders on the Reports page;
            those are just a tidy view and never share anything.
          </p>
        </div>
        <Link href="/commercial/reports" className="inline-flex items-center px-3 min-h-[44px] rounded-lg border border-ppp-charcoal-200 bg-surface text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50">
          Open Reports →
        </Link>
      </div>

      {!list.ok && (
        <div role="alert" className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[12.5px] text-amber-900">
          {list.error}
        </div>
      )}
      {error && <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{error}</div>}
      {saved && <div role="status" className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-[12.5px] text-emerald-900">{saved}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5 items-start">
        {/* ── Folder list ── On a phone the list steps aside once a folder is
            open, with a way back, so the detail isn't below a screen of rows. */}
        <div className={selected ? "hidden lg:block" : ""}>
          {folders.length > 0 && (
            <ul className="space-y-1.5 mb-4">
              {folders.map((f, i) => (
                <li key={f.id} className={`flex items-stretch rounded-lg border ${selected?.id === f.id ? "border-cc-brand-400 bg-cc-brand-50/40" : "border-ppp-charcoal-100 bg-surface"}`}>
                  <Link href={`${BASE}?folder=${f.id}`} aria-current={selected?.id === f.id ? "page" : undefined} className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2.5 min-h-[52px] rounded-l-lg hover:bg-ppp-charcoal-50/60">
                    <FolderGlyph icon={f.icon} size={17} className="text-ppp-navy-700 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-semibold text-ppp-charcoal truncate">{f.name}</span>
                      <span className="block text-[11px] text-ppp-charcoal-500 truncate">
                        {f.reportKeys.filter(isReportKey).length} reports · {f.members.length} {f.members.length === 1 ? "person" : "people"}
                      </span>
                    </span>
                  </Link>
                  {/* Side by side, each a full 44px target — stacked they were 26px. */}
                  <div className="flex border-l border-ppp-charcoal-100">
                    <form action={moveFolderAction} className="flex">
                      <input type="hidden" name="folder_id" value={f.id} />
                      <input type="hidden" name="selected" value={selected?.id ?? ""} />
                      <input type="hidden" name="dir" value="up" />
                      <SubmitButton disabled={i === 0} aria-label={`Move ${f.name} up`} pendingLabel="…" className="w-11 min-h-[44px] text-[14px] text-ppp-charcoal-500 hover:bg-ppp-charcoal-50">↑</SubmitButton>
                    </form>
                    <form action={moveFolderAction} className="flex border-l border-ppp-charcoal-100">
                      <input type="hidden" name="folder_id" value={f.id} />
                      <input type="hidden" name="selected" value={selected?.id ?? ""} />
                      <input type="hidden" name="dir" value="down" />
                      <SubmitButton disabled={i === folders.length - 1} aria-label={`Move ${f.name} down`} pendingLabel="…" className="w-11 min-h-[44px] text-[14px] text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 rounded-r-lg">↓</SubmitButton>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form action={createFolderAction} className="rounded-xl border border-ppp-charcoal-100 bg-surface p-3 space-y-2">
            <label className="block">
              <span className={LABEL_CLS}>New team folder</span>
              <input name="name" required maxLength={80} placeholder="e.g. Estimating" className={INPUT_CLS} />
            </label>
            <input type="hidden" name="icon" value="folder" />
            <SubmitButton className="w-full min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700" pendingLabel="Making…">
              Make folder
            </SubmitButton>
            {folders.length === 0 && list.ok && (
              <p className="text-[12px] text-ppp-charcoal-500">No team folders yet.</p>
            )}
          </form>
        </div>

        {/* ── Folder detail ── */}
        {selected ? (
          <div className="space-y-4 min-w-0">
            <Link href={BASE} className="lg:hidden inline-flex items-center min-h-[44px] text-[13px] font-semibold text-cc-brand-700">← All folders</Link>

            {/* Details */}
            <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
              <form action={updateFolderAction} className="space-y-3">
                <input type="hidden" name="folder_id" value={selected.id} />
                <label className="block">
                  <span className={LABEL_CLS}>Folder name</span>
                  <input name="name" defaultValue={selected.name} required maxLength={80} className={INPUT_CLS} />
                </label>
                <label className="block">
                  <span className={LABEL_CLS}>Description <span className="font-normal text-ppp-charcoal-400">(optional — shown under the name)</span></span>
                  <textarea name="description" rows={2} maxLength={280} defaultValue={selected.description ?? ""} className={TEXTAREA_CLS} />
                </label>
                <fieldset>
                  <legend className={LABEL_CLS}>Icon</legend>
                  <div className="flex flex-wrap gap-2">
                    {FOLDER_ICONS.map((ic) => (
                      <label key={ic} className="cursor-pointer">
                        <input type="radio" name="icon" value={ic} defaultChecked={selected.icon === ic} className="peer sr-only" />
                        <span
                          title={FOLDER_ICON_LABEL[ic]}
                          className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-500 peer-checked:border-cc-brand-600 peer-checked:bg-cc-brand-50 peer-checked:text-cc-brand-700 peer-focus-visible:ring-2 peer-focus-visible:ring-cc-brand-600/40"
                        >
                          <FolderGlyph icon={ic} size={18} />
                          <span className="sr-only">{FOLDER_ICON_LABEL[ic]}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <SubmitButton className="px-4 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700" pendingLabel="Saving…">
                  Save details
                </SubmitButton>
              </form>
            </section>

            {/* Reports */}
            <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
              <h2 className="text-[15px] font-bold text-ppp-charcoal">Reports in this folder</h2>
              <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 mb-3">Everyone in the folder can open these. Tick and save.</p>
              <form action={setReportsAction} className="space-y-4">
                <input type="hidden" name="folder_id" value={selected.id} />
                {REPORT_GROUPS.map((g) => (
                  <fieldset key={g.key}>
                    <legend className="font-condensed text-[12px] font-bold uppercase tracking-[0.14em] text-ppp-navy-700 mb-1">{g.label}</legend>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {REPORTS.filter((r) => r.group === g.key).map((r) => (
                        <label key={r.key} className="flex items-start gap-3 rounded-lg border border-ppp-charcoal-100 px-3 py-2.5 min-h-[52px] cursor-pointer hover:bg-ppp-charcoal-50/60 has-[:checked]:border-cc-brand-300 has-[:checked]:bg-cc-brand-50/30">
                          <input
                            type="checkbox"
                            name="report_key"
                            value={r.key}
                            defaultChecked={selected.reportKeys.includes(r.key)}
                            className="mt-0.5 h-5 w-5 shrink-0 accent-cc-brand-600"
                          />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ppp-charcoal">
                              <PathIcon paths={r.icon} size={14} className="text-ppp-charcoal-400 shrink-0" />
                              {r.title}
                            </span>
                            {r.requires === "people" && (
                              <span className="block text-[11px] text-ppp-charcoal-500 mt-0.5">Only admins &amp; account managers can open it, even from a folder.</span>
                            )}
                            {r.exportRequires === "people" && (
                              <span className="block text-[11px] text-ppp-charcoal-500 mt-0.5">Per-person pay and its export stay admins &amp; account managers only.</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
                <SubmitButton className="px-4 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700" pendingLabel="Saving…">
                  Save reports
                </SubmitButton>
              </form>

              {selected.reportKeys.filter(isReportKey).length > 1 && (
                <div className="mt-5 pt-4 border-t border-ppp-charcoal-100">
                  <h3 className="text-[13px] font-bold text-ppp-charcoal">Order</h3>
                  <p className="text-[12px] text-ppp-charcoal-500 mb-2">The order cards appear in on the Reports page.</p>
                  <ol className="space-y-1.5">
                    {selected.reportKeys.filter(isReportKey).map((k, i, arr) => (
                      <li key={k} className="flex items-center gap-2 rounded-lg border border-ppp-charcoal-100 pl-3">
                        <span className="w-5 text-[11px] font-bold tabular-nums text-ppp-charcoal-400">{i + 1}</span>
                        <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-ppp-charcoal">{reportDef(k).title}</span>
                        <form action={moveReportAction}>
                          <input type="hidden" name="folder_id" value={selected.id} />
                          <input type="hidden" name="report_key" value={k} />
                          <input type="hidden" name="dir" value="up" />
                          <SubmitButton disabled={i === 0} aria-label={`Move ${reportDef(k).title} earlier`} pendingLabel="…" className="h-11 w-11 text-ppp-charcoal-500 hover:bg-ppp-charcoal-50">↑</SubmitButton>
                        </form>
                        <form action={moveReportAction}>
                          <input type="hidden" name="folder_id" value={selected.id} />
                          <input type="hidden" name="report_key" value={k} />
                          <input type="hidden" name="dir" value="down" />
                          <SubmitButton disabled={i === arr.length - 1} aria-label={`Move ${reportDef(k).title} later`} pendingLabel="…" className="h-11 w-11 text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 rounded-r-lg">↓</SubmitButton>
                        </form>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>

            {/* People */}
            <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
              <h2 className="text-[15px] font-bold text-ppp-charcoal">People</h2>
              <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 mb-3">They see this folder&rsquo;s reports on their Reports page.</p>
              {selected.members.length === 0 ? (
                <p className="text-[12.5px] text-ppp-charcoal-500 mb-3">Nobody yet — add someone below.</p>
              ) : (
                <ul className="space-y-1.5 mb-4">
                  {selected.members.map((m) => (
                    <li key={m.memberId} className="flex items-center gap-2 rounded-lg border border-ppp-charcoal-100 pl-3 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{m.name}</div>
                        {m.email && <div className="text-[11px] text-ppp-charcoal-500 truncate">{m.email}</div>}
                        <div className="flex flex-wrap gap-1 mt-1">
                          {m.role === "admin" && <Chip>Admin · sees every report</Chip>}
                          {!m.hasCommercial && (
                            <Link href="/commercial/settings/access" className="inline-flex">
                              <Chip>No Commercial access — turn on →</Chip>
                            </Link>
                          )}
                          {!m.isActive && <Chip>Deactivated</Chip>}
                        </div>
                      </div>
                      <form action={removeMemberAction} className="shrink-0">
                        <input type="hidden" name="folder_id" value={selected.id} />
                        <input type="hidden" name="member_id" value={m.memberId} />
                        <SubmitButton aria-label={`Remove ${m.name} from ${selected.name}`} pendingLabel="Removing…" className="px-3 min-h-[44px] text-[12px] font-semibold text-ppp-charcoal-500 hover:text-rose-700">
                          Remove
                        </SubmitButton>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              {addable.length === 0 ? (
                <p className="text-[12px] text-ppp-charcoal-500">Everyone with a login is already in this folder.</p>
              ) : (
                <form action={addMemberAction} className="border-t border-ppp-charcoal-100 pt-3 flex items-end gap-2 flex-wrap">
                  <input type="hidden" name="folder_id" value={selected.id} />
                  <label className="block flex-1 min-w-[200px]">
                    <span className={LABEL_CLS}>Add a person</span>
                    <SearchableSelect name="user_id" options={addable} placeholder="Search by name or email…" ariaLabel={`Add a person to ${selected.name}`} />
                  </label>
                  <SubmitButton className="px-4 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700" pendingLabel="Adding…">
                    Add
                  </SubmitButton>
                </form>
              )}
              <p className="text-[11.5px] text-ppp-charcoal-500 mt-2">
                Someone not listed doesn&rsquo;t have a login yet — create one in{" "}
                <Link href="/commercial/settings/access" className="font-semibold text-cc-brand-700 hover:underline">Access &amp; Users</Link>, then add them here.
              </p>
            </section>

            <section className="rounded-xl border border-rose-100 p-4 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[12.5px] text-ppp-charcoal-600 min-w-0">Deleting the folder stops its people seeing these reports through it. The reports stay.</p>
              <form action={deleteFolderAction}>
                <input type="hidden" name="folder_id" value={selected.id} />
                <ConfirmSubmitButton
                  message={`Delete the folder “${selected.name}”? ${selected.members.length} ${selected.members.length === 1 ? "person" : "people"} will stop seeing its reports through it.`}
                  pendingLabel="Deleting…"
                  className="px-3 min-h-[44px] rounded-lg text-[13px] font-semibold text-rose-700 hover:bg-rose-50 touch-manipulation"
                >
                  Delete folder
                </ConfirmSubmitButton>
              </form>
            </section>
          </div>
        ) : (
          <div className="hidden lg:block bg-surface border border-ppp-charcoal-100 rounded-xl p-6 text-center">
            <p className="text-sm font-semibold text-ppp-charcoal">Pick a folder to choose its reports and people</p>
            <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Or make a new one on the left.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-ppp-charcoal-100 px-2 py-0.5 text-[10.5px] font-semibold text-ppp-charcoal-700">
      {children}
    </span>
  );
}
