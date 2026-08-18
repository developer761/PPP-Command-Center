-- 152 · Fix submittal uploads + declare every storage bucket. (Stephanie, 2026-08-18)
--
-- THE BUG she hit, with the evidence:
--   Submittals → "Attached spec sheets & samples" → 16 files, every one:
--   "Upload failed — this account isn't allowed to upload."
--   Meanwhile "uploading plans in new opportunities is fine."
--
-- That message is not generic. direct-attachment-client.ts only prints it when
-- Storage's response body matches /row-level security|Unauthorized|AccessDenied/.
-- So Storage explicitly refused the row on RLS — the bucket is there, the
-- policy is not.
--
-- ROOT CAUSE. Migration 137 fixed exactly this class for ONE bucket and said so
-- out loud: "ONE bucket. commercial-documents is the only bucket the browser
-- writes to; the rest stay service-role-only, which is the tighter default."
-- That was correct when it was written. It stopped being correct when the
-- submittal attachment uploader shipped on the SAME direct-to-browser transport
-- but pointed at commercial-opportunity-files. Plans & Specs kept working
-- because it writes to commercial-documents, which has the policy — which is
-- precisely why "plans upload fine but submittals don't."
--
-- A signed upload URL authorises the PATH; the insert still runs as the
-- signed-in user, so every bucket the browser writes to needs its own policy.
--
-- SECOND, SMALLER PROBLEM found while tracing it. No migration has ever created
-- a bucket except 088. Every other one wrote a comment asking a human to make it
-- by hand in the dashboard:
--   032 → "Karan creates the bucket in the Supabase UI before this migration"
--   036 → "Karan must create the bucket via Supabase UI"
--   047 → "Create bucket: commercial-documents"
--   109 → "If the bucket doesn't exist yet (fresh env), create it in the
--          Supabase dashboard first, then re-run."
-- That works until someone forgets, and it guarantees a fresh environment comes
-- up broken. All five are declared below, idempotently, so the next staging
-- project or rebuild starts working instead of starting broken. On the live
-- project these inserts are no-ops.
--
-- All buckets are PRIVATE. Reads go through server-minted signed URLs.

-- ── Buckets ────────────────────────────────────────────────────────────────
-- file_size_limit matches the ceiling each module already enforces in code, so
-- Storage and the app agree on what "too big" means. A mismatch here is how you
-- get a file that passes validation and then dies at the PUT.

insert into storage.buckets (id, name, public, file_size_limit)
values
  -- Plans, bid sets, closeout packages. 100 MB — see 109 and MAX_UPLOAD_BYTES
  -- in lib/commercial/documents/db.ts.
  ('commercial-documents',         'commercial-documents',         false, 104857600),
  -- Account compliance docs (W-9, COI, licences). 50 MB — MAX_UPLOAD_BYTES in
  -- lib/commercial/accounts/documents.ts.
  ('commercial-account-docs',      'commercial-account-docs',      false, 52428800),
  -- Files attached to an opportunity. Same 50 MB ceiling.
  ('commercial-opportunity-files', 'commercial-opportunity-files', false, 52428800),
  -- Inbound email attachments. 25 MB — Resend's own hard cap, mirrored in
  -- MAX_ATTACHMENT_BYTES in lib/commercial/email-archive/inbound.ts.
  ('commercial-email-attachments', 'commercial-email-attachments', false, 26214400),
  -- Operating-company logo + signature. Small by nature; 10 MB is generous.
  ('commercial-brand-assets',      'commercial-brand-assets',      false, 10485760)
on conflict (id) do nothing;

-- Bring any hand-made bucket up to the same ceiling. A bucket created through
-- the dashboard defaults to the project-wide limit, which is smaller than what
-- the app advertises — so a 60 MB plan set would pass the app's check and then
-- be refused by Storage.
update storage.buckets set file_size_limit = 104857600 where id = 'commercial-documents'         and coalesce(file_size_limit, 0) < 104857600;
update storage.buckets set file_size_limit = 52428800  where id = 'commercial-account-docs'      and coalesce(file_size_limit, 0) < 52428800;
update storage.buckets set file_size_limit = 52428800  where id = 'commercial-opportunity-files' and coalesce(file_size_limit, 0) < 52428800;
update storage.buckets set file_size_limit = 26214400  where id = 'commercial-email-attachments' and coalesce(file_size_limit, 0) < 26214400;
update storage.buckets set file_size_limit = 10485760  where id = 'commercial-brand-assets'      and coalesce(file_size_limit, 0) < 10485760;

-- ── RLS for direct browser uploads ─────────────────────────────────────────
-- Background is in 137: a signed upload URL authorises the PATH, but the insert
-- still runs as the signed-in user, so storage.objects needs a matching policy
-- or Storage refuses the row and reports it as a flat HTTP 400.
--
-- 137 granted this for commercial-documents. Opportunity attachments use the
-- same direct-to-Storage transport (attachment-upload.ts calls
-- createSignedUploadUrl), so they need it too — that upload would have failed
-- even once its bucket existed.
--
-- Deliberately narrow, matching 137: INSERT only, `authenticated` only, never
-- `anon`. Getting a signed URL at all already required a server-side
-- authorisation check; this is the second gate, not the first. The remaining
-- buckets are written server-side under the service role, which bypasses RLS,
-- so they stay policy-free and therefore closed to the browser.

drop policy if exists "commercial opportunity files: authenticated upload" on storage.objects;

create policy "commercial opportunity files: authenticated upload"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'commercial-opportunity-files');
