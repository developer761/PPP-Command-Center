-- 109 · R6b — raise the commercial-documents bucket ceiling to 100 MB.
--
-- Background: large uploads (bid sets, plan sets) now go DIRECTLY from the
-- browser to Supabase Storage via a signed upload URL (see
-- lib/commercial/documents/large-upload.ts), bypassing Vercel's ~4.5 MB
-- serverless request-body cap that silently blocked big files on the old
-- multipart route. The storage layer still enforces the bucket's own
-- file_size_limit on the actual PUT, so it must allow the full 100 MB the app
-- advertises (MAX_UPLOAD_BYTES in lib/commercial/documents/db.ts).
--
-- Idempotent + safe: only touches the size limit on an existing bucket. If the
-- bucket doesn't exist yet (fresh env), create it in the Supabase dashboard
-- first, then re-run.

update storage.buckets
set file_size_limit = 104857600  -- 100 MiB (100 * 1024 * 1024)
where id = 'commercial-documents';
