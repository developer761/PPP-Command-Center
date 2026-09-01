import { flashMessage } from "@/lib/commercial/flash";
import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { INPUT_CLS, LABEL_CLS, SELECT_CLS, SELECT_BG_STYLE, TEXTAREA_CLS } from "@/lib/commercial/form-classnames";
import { SearchableSelect } from "@/components/commercial/searchable-select";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { ASSIGNMENT_ROLES, assignmentRoleLabel } from "@/lib/commercial/accounts/assignment-roles";
import {
  listTeams,
  getTeam,
  listAssignableUsers,
  createTeam,
  renameTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  updateTeamMember,
} from "@/lib/commercial/teams/db";
import { SubmitButton } from "@/components/commercial/submit-button";

export const dynamic = "force-dynamic";
const BASE = "/commercial/settings/teams";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function createTeamAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const res = await createTeam(String(formData.get("name") ?? ""), uid);
  revalidatePath(BASE);
  redirect(res.ok ? `${BASE}?team=${res.id}` : `${BASE}?error=${encodeURIComponent(res.error)}`);
}
async function renameTeamAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = String(formData.get("team_id") ?? "");
  if (!UUID_RE.test(id)) redirect(BASE);
  const res = await renameTeam(id, String(formData.get("name") ?? ""), uid);
  revalidatePath(BASE);
  redirect(res.ok ? `${BASE}?team=${id}` : `${BASE}?team=${id}&error=${encodeURIComponent(res.error)}`);
}
/** Territory: which zips this team covers (Karan 2026-08-26). */
async function setZipsAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = String(formData.get("team_id") ?? "");
  if (!UUID_RE.test(id)) redirect(BASE);
  const { parseZipPrefixes } = await import("@/lib/commercial/teams/zip-territory");
  const { setTeamZipPrefixes } = await import("@/lib/commercial/teams/db");
  const res = await setTeamZipPrefixes(id, parseZipPrefixes(String(formData.get("zips") ?? "")), uid);
  revalidatePath(BASE);
  redirect(
    res.ok
      ? `${BASE}?team=${id}&zips_ok=${res.prefixes.length}`
      : `${BASE}?team=${id}&error=${encodeURIComponent(res.error)}`
  );
}

async function deleteTeamAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = String(formData.get("team_id") ?? "");
  if (!UUID_RE.test(id)) redirect(BASE);
  const res = await deleteTeam(id, uid);
  revalidatePath(BASE);
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error ?? "Could not delete that team.")}`);
  redirect(BASE);
}
async function addMemberAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = String(formData.get("team_id") ?? "");
  const userId = String(formData.get("user_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(userId)) redirect(`${BASE}?team=${id}&error=${encodeURIComponent("Pick a person.")}`);
  const res = await addTeamMember(id, userId, String(formData.get("role") ?? "other"), uid);
  revalidatePath(BASE);
  redirect(res.ok ? `${BASE}?team=${id}` : `${BASE}?team=${id}&error=${encodeURIComponent(res.error)}`);
}
async function removeMemberAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = String(formData.get("team_id") ?? "");
  const memberId = String(formData.get("member_id") ?? "");
  // Two things were being thrown away here. A failure looked like it worked, so
  // someone stayed on the team with their access intact. And when the SOLE team
  // admin is removed, the source hands that authority to another member — a real
  // RBAC change that nobody was ever told about.
  let notice = "";
  if (UUID_RE.test(memberId)) {
    const res = await removeTeamMember(memberId, uid);
    if (!res.ok) {
      revalidatePath(BASE);
      redirect(`${BASE}?team=${id}&error=${encodeURIComponent(res.error ?? "Could not remove that member.")}`);
    }
    if (res.promotedAdmin) {
      notice = `&heads_up=${encodeURIComponent(`${res.promotedAdmin} is now the team admin — they were the next member in line after you removed the only one.`)}`;
    }
  }
  revalidatePath(BASE);
  redirect(`${BASE}?team=${id}${notice}`);
}
async function updateMemberAction(formData: FormData) {
  "use server";
  const uid = await requireAdmin();
  const id = String(formData.get("team_id") ?? "");
  const memberId = String(formData.get("member_id") ?? "");
  const field = String(formData.get("field") ?? "");
  let notice = "";
  if (UUID_RE.test(memberId)) {
    const res =
      field === "admin"
        ? await updateTeamMember(memberId, { is_team_admin: true }, uid)
        : field === "role"
          ? await updateTeamMember(memberId, { role: String(formData.get("role") ?? "other") }, uid)
          : null;
    if (res && !res.ok) {
      revalidatePath(BASE);
      redirect(`${BASE}?team=${id}&error=${encodeURIComponent(res.error ?? "Could not update that member.")}`);
    }
    if (res?.promotedAdmin) {
      notice = `&heads_up=${encodeURIComponent(`${res.promotedAdmin} is now the team admin — they were the next member in line.`)}`;
    }
  }
  revalidatePath(BASE);
  redirect(`${BASE}?team=${id}${notice}`);
}

export default async function TeamsSettingsPage({ searchParams }: { searchParams: Promise<{ team?: string; error?: string; heads_up?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const selectedId = sp.team && UUID_RE.test(sp.team) ? sp.team : null;
  const [teams, selected, users] = await Promise.all([
    listTeams(),
    selectedId ? getTeam(selectedId) : Promise.resolve(null),
    listAssignableUsers(),
  ]);
  const memberIds = new Set((selected?.members ?? []).map((m) => m.user_id));
  const addableUsers = users.filter((u) => !memberIds.has(u.user_id)).map((u) => ({ value: u.user_id, label: u.name, hint: u.email || undefined }));

  return (
    <div className="pb-8 max-w-4xl">
      <div className="mb-1"><Link href="/commercial/settings" className="text-[12px] font-semibold text-cc-brand-700 hover:underline">← Settings</Link></div>
      <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Teams</h1>
      <p className="text-[13px] text-ppp-charcoal-500 mt-1 mb-5">Build a reusable team once — a name, a team admin, and members with roles — then assign the whole team to an account or opportunity by name.</p>

      {sp.error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{flashMessage(sp.error)}</div>}
      {/* Team-admin authority moving is a real access change. It used to happen
          silently — the sole admin was removed and the system handed the role to
          whoever was next, with nobody told. */}
      {sp.heads_up && <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[12.5px] text-amber-800">{flashMessage(sp.heads_up)}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5">
        {/* Team list + create */}
        <div>
          <form action={createTeamAction} className="flex items-end gap-2 mb-3">
            <label className="block flex-1"><span className={LABEL_CLS}>New team</span><input name="name" required maxLength={120} placeholder="e.g. Manhattan Crew" className={INPUT_CLS} /></label>
            <SubmitButton
              className="px-3 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700"
            >Create</SubmitButton>
          </form>
          {teams.length === 0 ? (
            <p className="text-[12.5px] text-ppp-charcoal-500">No teams yet — create one above.</p>
          ) : (
            <ul className="space-y-1.5">
              {teams.map((t) => (
                <li key={t.id}>
                  <Link href={`${BASE}?team=${t.id}`} className={`block rounded-lg border px-3 py-2.5 min-h-[44px] ${selectedId === t.id ? "border-cc-brand-400 bg-cc-brand-50/40" : "border-ppp-charcoal-100 hover:bg-ppp-charcoal-50"}`}>
                    <div className="text-[13.5px] font-semibold text-ppp-charcoal truncate">{t.name}</div>
                    <div className="text-[11px] text-ppp-charcoal-500 truncate">{t.member_count} member{t.member_count === 1 ? "" : "s"}{t.admin_name ? ` · admin: ${t.admin_name}` : " · no admin"}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Team detail */}
        {selected ? (
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
              <form action={renameTeamAction} className="flex items-end gap-2 min-w-0 flex-1">
                <input type="hidden" name="team_id" value={selected.id} />
                <label className="block flex-1 min-w-[160px]"><span className={LABEL_CLS}>Team name</span><input name="name" defaultValue={selected.name} required maxLength={120} className={INPUT_CLS} /></label>
                <SubmitButton
                  className="px-3 min-h-[44px] rounded-lg border border-ppp-charcoal-200 text-[12.5px] font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50"
                >Rename</SubmitButton>
              </form>
              <form action={deleteTeamAction} className="self-end">
                <input type="hidden" name="team_id" value={selected.id} />
                <ConfirmSubmitButton message={`Delete the team "${selected.name}"? It will be removed from any account/opportunity it's assigned to.`} pendingLabel="Deleting…" className="inline-flex items-center px-3 min-h-[44px] rounded-lg text-[12px] font-semibold text-rose-700 hover:bg-rose-50 touch-manipulation">Delete team</ConfirmSubmitButton>
              </form>
            </div>

            {/* Territory — Brendan 2026-08-25: "the location of the job will
                determine the team who will execute the project." */}
            <h2 className="text-sm font-bold text-ppp-charcoal mb-1">Territory</h2>
            <p className="text-[12px] text-ppp-charcoal-500 mb-2">
              Zip codes this team covers. A new job in one of them picks this team automatically —
              you can still change it on the job. Use a prefix for a whole area:{" "}
              <span className="font-mono">117</span> covers all of Suffolk,{" "}
              <span className="font-mono">11722</span> claims one town back from it.
              The most specific wins, and two teams may share a zip.
            </p>
            <form action={setZipsAction} className="mb-5">
              <input type="hidden" name="team_id" value={selected.id} />
              <textarea
                name="zips"
                rows={2}
                defaultValue={selected.zip_prefixes.join(", ")}
                placeholder="117, 11722, 11780"
                className={TEXTAREA_CLS}
                aria-label={`Zip codes covered by ${selected.name}`}
              />
              <div className="flex items-center gap-3 mt-2">
                <SubmitButton
                  className="px-3 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-semibold hover:bg-cc-brand-700"
                >Save territory</SubmitButton>
                <span className="text-[11.5px] text-ppp-charcoal-500">
                  {selected.zip_prefixes.length === 0
                    ? "No zips yet — this team is never picked automatically."
                    : `${selected.zip_prefixes.length} zip${selected.zip_prefixes.length === 1 ? "" : " code"}${selected.zip_prefixes.length === 1 ? "" : "s"} covered`}
                </span>
              </div>
            </form>

            <h2 className="text-sm font-bold text-ppp-charcoal mb-2">Members</h2>
            {selected.members.length === 0 ? (
              <p className="text-[12.5px] text-ppp-charcoal-500 mb-3">No members yet — add someone below.</p>
            ) : (
              <ul className="space-y-2 mb-4">
                {selected.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 flex-wrap border border-ppp-charcoal-100 rounded-lg px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{m.name}{m.is_team_admin && <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wide text-cc-brand-700 bg-cc-brand-50 rounded px-1 py-0.5">Team admin</span>}</div>
                      {m.email && <div className="text-[11px] text-ppp-charcoal-400 truncate">{m.email}</div>}
                    </div>
                    <form action={updateMemberAction} className="shrink-0 flex items-center gap-1">
                      <input type="hidden" name="team_id" value={selected.id} />
                      <input type="hidden" name="member_id" value={m.id} />
                      <input type="hidden" name="field" value="role" />
                      <select name="role" defaultValue={m.role} className={`${SELECT_CLS} !py-1.5 text-base sm:text-[12px] w-[150px]`} style={SELECT_BG_STYLE}>
                        {ASSIGNMENT_ROLES.map((r) => <option key={r} value={r}>{assignmentRoleLabel(r)}</option>)}
                      </select>
                      <SubmitButton
                        className="text-[11px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] px-1"
                      >Set</SubmitButton>
                    </form>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!m.is_team_admin && (
                        <form action={updateMemberAction}>
                          <input type="hidden" name="team_id" value={selected.id} />
                          <input type="hidden" name="member_id" value={m.id} />
                          <input type="hidden" name="field" value="admin" />
                          <SubmitButton
                            className="text-[11px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] px-1.5"
                          >Make admin</SubmitButton>
                        </form>
                      )}
                      <form action={removeMemberAction}>
                        <input type="hidden" name="team_id" value={selected.id} />
                        <input type="hidden" name="member_id" value={m.id} />
                        <SubmitButton
                          className="text-[11px] font-semibold text-ppp-charcoal-500 hover:text-rose-700 min-h-[44px] px-1.5"
                        >Remove</SubmitButton>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* Add member */}
            {addableUsers.length === 0 ? (
              <p className="text-[12px] text-ppp-charcoal-400">Everyone with commercial access is already on this team.</p>
            ) : (
              <form action={addMemberAction} className="border-t border-ppp-charcoal-50 pt-3 flex items-end gap-2 flex-wrap">
                <input type="hidden" name="team_id" value={selected.id} />
                <label className="block flex-1 min-w-[180px]"><span className={LABEL_CLS}>Add a member</span><SearchableSelect name="user_id" options={addableUsers} placeholder="Search staff…" ariaLabel="Add a team member" /></label>
                <label className="block"><span className={LABEL_CLS}>Role</span>
                  <select name="role" defaultValue="other" className={SELECT_CLS} style={SELECT_BG_STYLE}>
                    {ASSIGNMENT_ROLES.map((r) => <option key={r} value={r}>{assignmentRoleLabel(r)}</option>)}
                  </select>
                </label>
                <SubmitButton
                  className="px-3 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700"
                >Add</SubmitButton>
              </form>
            )}
          </div>
        ) : (
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-6 text-center self-start">
            <p className="text-sm font-semibold text-ppp-charcoal">Pick a team to manage its members</p>
            <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Or create a new one on the left.</p>
          </div>
        )}
      </div>
    </div>
  );
}
