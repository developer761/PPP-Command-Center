-- ============================================================================
-- Only a Commercial user may write into the Commercial storage buckets.
-- ============================================================================
--
-- 137 and 152 let the browser insert into commercial-documents and
-- commercial-opportunity-files, and the ONLY predicate was the bucket:
--
--     with check (bucket_id = 'commercial-documents')
--
-- Both said "getting a signed URL at all already required a server-side
-- authorisation check; this is the second gate, not the first." That holds for
-- the app's own path, but the policy is what the Storage API checks, and the
-- Storage API does not need a signed URL. Any session holding an
-- `authenticated` JWT — a residential-only rep, a crew-only painter, a login
-- whose Commercial access was switched off — could POST straight to
-- /storage/v1/object/commercial-documents/<anything> with the public
-- publishable key and its own token, and the row was accepted: up to the
-- bucket's 100 MB (50 MB on opportunity files) per object, any MIME type
-- (152 declares no allowed_mime_types), any path. They could not read or
-- overwrite (no select/update policy), but they could fill the buckets and
-- plant objects under real account/opportunity prefixes that nothing in the
-- app would ever reconcile.
--
-- So the second gate now asks the same question as the first. Both sign routes
-- (app/api/commercial/opportunities/[id]/{documents,attachments}/sign) refuse
-- unless ALL of:
--   * profiles.has_new_platform_access is true,
--   * profiles.is_active is not false, and
--   * the user is not crew-only (denyCrewApi → isCrewOnlyUser: has roles, and
--     every one of them is 'crew').
-- commercial_can_upload() below is that predicate, in SQL. Nobody the app lets
-- upload is refused by it — the app already refuses everyone else before it
-- mints the URL — so no real workflow loses access.
--
-- SECURITY DEFINER because the check reads profiles and commercial_user_roles,
-- which an `authenticated` caller cannot read the way this needs: the
-- profiles_admin_read policy (002) selects from profiles inside a policy on
-- profiles, so evaluating it as the caller raises "infinite recursion detected
-- in policy" and the upload would fail for everyone. search_path is pinned
-- empty and every name is schema-qualified, so the definer cannot be pointed at
-- a planted table. It takes no argument and reads auth.uid() itself, so a
-- caller cannot ask about somebody else.
--
-- EVERY UPLOAD PATH IN THE CODE, and what this does to it (2026-10-16):
--
--   Browser, signed-URL PUT as the user's JWT — the ONLY kind this policy sees:
--     1. lib/commercial/uploads/direct-upload-client.ts → documents/sign →
--        commercial-documents. Plans & specs, Stephanie's >50 MB bid sets.
--     2. lib/commercial/uploads/direct-attachment-client.ts → attachments/sign
--        → commercial-opportunity-files. Submittal spec sheets, lien waivers,
--        proposal markups (submittal-direct-upload, lien-waiver-upload,
--        proposal-markup-upload, commercial-files-upload-form, file-row-actions).
--     3. components/commercial-opportunity-upload-form.tsx → supabase-js
--        uploadToSignedUrl → attachments/sign → commercial-opportunity-files.
--     All three are minted only after the sign route's has_new_platform_access
--     + is_active + denyCrewApi check, which is exactly what the policy now
--     asks, so every user who reaches the PUT still passes it. Size is not
--     touched: the buckets' file_size_limit is not changed here.
--
--   Server-side under the service role — bypasses RLS, unaffected:
--     documents/db.ts (incl. the purchase-receipt photos Mary takes on her
--     phone: costs-tool and accounting post the file to a server action,
--     which uploads it), accounts/documents.ts, opportunities/attachments.ts,
--     email-archive/inbound.ts, esign/db.ts, operating-company/assets.ts.
--
-- NOT APPLIED BY THE AUTHOR. Apply with the usual migration step.
--
-- After applying, test, as real users on the live site:
--   a. Stephanie (or any non-crew Commercial user): upload a >50 MB plan set
--      on an opportunity's Plans & Specs → it completes and appears.
--   b. Same user: attach a file to a submittal (opportunity files bucket).
--   c. Mary: add a purchase with a phone-camera receipt → receipt appears.
--   d. An admin: upload the operating-company logo in Settings.
--   e. Refusal, without touching real data: sign in as a residential-only
--      user, and in the browser console run
--        const { data: { session } } = await supabase.auth.getSession();
--        fetch(`${SUPABASE_URL}/storage/v1/object/commercial-documents/zz-rls-probe.txt`,
--          { method: "POST", headers: { apikey: PUBLISHABLE_KEY,
--            authorization: `Bearer ${session.access_token}` }, body: "x" })
--      → expect 400/403 "new row violates row-level security". Before this
--      migration it returned 200; if it still does, delete zz-rls-probe.txt.
--   If (a)-(d) fail with "row-level security", run
--     select public.commercial_can_upload();
--   as that user (SQL editor → "impersonate") to see which clause refused.
--
-- Verify after applying (as the SQL editor's postgres role):
--   select polname, pg_get_expr(polwithcheck, polrelid)
--     from pg_policy
--    where polrelid = 'storage.objects'::regclass
--      and polname like 'commercial %upload';
--   -- both rows must show: ... AND public.commercial_can_upload()

create or replace function public.commercial_can_upload()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1
             from public.profiles p
            where p.user_id = auth.uid()
              and p.has_new_platform_access is true
              and p.is_active is distinct from false
         )
     and not (
           exists (select 1 from public.commercial_user_roles r
                    where r.user_id = auth.uid() and r.role = 'crew')
       and not exists (select 1 from public.commercial_user_roles r
                        where r.user_id = auth.uid() and r.role <> 'crew')
         );
$$;

revoke all on function public.commercial_can_upload() from public;
revoke all on function public.commercial_can_upload() from anon;
grant execute on function public.commercial_can_upload() to authenticated;

drop policy if exists "commercial documents: authenticated upload" on storage.objects;

create policy "commercial documents: authenticated upload"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'commercial-documents' and public.commercial_can_upload());

drop policy if exists "commercial opportunity files: authenticated upload" on storage.objects;

create policy "commercial opportunity files: authenticated upload"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'commercial-opportunity-files' and public.commercial_can_upload());
