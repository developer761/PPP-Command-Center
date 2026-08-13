-- 137 — let signed browser uploads actually write to Storage.
--
-- Bug (Stephanie, 2026-08-13): "Documents > 'Storage rejected the file
-- HTTP400' after trying to upload a 86kb set of plans" — and the same on Work
-- Orders, which mounts the same uploader. The 86 KB was a red herring; so was
-- the file type. EVERY browser upload was failing, and had been since the
-- direct-to-Storage transport shipped.
--
-- Root cause: the commercial buckets (created in 047, 088, 109) have no RLS
-- policies on storage.objects at all. That was invisible because every other
-- upload path runs server-side under the service role, which bypasses RLS.
-- The direct-to-Storage transport is the only path that writes from the
-- browser, so it is the only one that ever met the policy check.
--
-- A signed upload URL does NOT bypass RLS. It authorises the PATH; the insert
-- still runs as whoever holds the bearer token. The client was sending the
-- publishable key, so the insert ran as `anon` — no policy, refused row, and
-- Storage reports that refusal as a flat HTTP 400.
--
-- Two-part fix. The client now sends the signed-in user's access token
-- (direct-upload-client.ts), and this grants that role the matching insert.
--
-- Scoped deliberately:
--   * ONE bucket. commercial-documents is the only bucket the browser writes
--     to; the rest stay service-role-only, which is the tighter default.
--   * INSERT only. Reads go through server-minted signed download URLs, and
--     nothing in the browser updates or deletes an object.
--   * `authenticated` only, never `anon`. Getting this far already requires a
--     server-side authorisation check to mint the signed URL, so this is the
--     second gate, not the first.
--
-- RLS is already enabled on storage.objects by Supabase (proven by the
-- refusal), and the table is owned by supabase_storage_admin, so we create the
-- policy without touching the table's RLS flag.

drop policy if exists "commercial documents: authenticated upload" on storage.objects;

create policy "commercial documents: authenticated upload"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'commercial-documents');
