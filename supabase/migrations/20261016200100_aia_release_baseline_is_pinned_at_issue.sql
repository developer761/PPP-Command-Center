-- ============================================================================
-- Pin each issued AIA certificate's retainage-release baseline, and give
-- every G703 line an identity nobody can type over.
-- ============================================================================
--
-- TWO defects, one root: the release a certificate counts its released
-- retainage from was found by matching on things a person can edit.
--
-- 1. WHICH RELEASE. A certificate reads the latest issued retainage release
--    whose application_number is BELOW its own. The number stays editable
--    after issue (it is how the GC files the certificate — Stephanie renumbers
--    on purpose), so sliding release #5 above paid #6 on LMJ Cipla takes #6's
--    G702 line 5 from $50.00 to $4,431.36. One form field, a paid document
--    restated.
--
--    `release_baseline_app_id` + `release_baseline_pinned_at` are stamped when
--    a certificate is ISSUED, in the same write that stamps
--    contract_sum_frozen_cents. The timestamp is what says "pinned": a pinned
--    NULL id means "there was no release", which is a real answer and must not
--    be confused with "never stamped".
--
-- 2. WHICH LINE. A line was matched to its row on the release sheet by
--    item_no, then description. Both are free text; changing "1" to "01"
--    moved a line from $575.00 to $4,025.00 of retainage. `source_line_id` is
--    the ROOT of the carry-forward chain (the first application's row),
--    stamped by the seed, so every generation shares one id with the release
--    sheet. Code falls back to a normalised item_no for rows with no shared
--    root, which is every row seeded before this.
--
-- THE BACKFILL pins what is printed TODAY: every issued certificate gets the
-- release the current rule picks — latest submitted/paid live release below
-- its number, lowest id on a tie (`pickReleaseApplication`). That is the
-- figure on the paper the GC holds, so pinning it changes no number.
--
-- The app tolerates this migration being un-applied: reads use `*`, writes
-- drop the columns and retry, and `updateAiaApplication` refuses a release
-- renumber that would cross an issued certificate until it is.

alter table public.commercial_aia_applications
  add column if not exists release_baseline_app_id uuid
    references public.commercial_aia_applications (id) on delete set null,
  add column if not exists release_baseline_pinned_at timestamptz;

alter table public.commercial_aia_line_items
  add column if not exists source_line_id uuid
    references public.commercial_aia_line_items (id) on delete set null;

create index if not exists commercial_aia_line_items_source_line_idx
  on public.commercial_aia_line_items (source_line_id)
  where source_line_id is not null;

update public.commercial_aia_applications a
   set release_baseline_app_id = (
         select r.id
           from public.commercial_aia_applications r
          where r.opportunity_id = a.opportunity_id
            and r.is_retainage_release
            and r.status in ('submitted', 'paid')
            and r.deleted_at is null
            and r.application_number < a.application_number
          order by r.application_number desc, r.id asc
          limit 1
       ),
       release_baseline_pinned_at = now()
 where a.status in ('submitted', 'paid')
   and a.deleted_at is null
   and a.release_baseline_pinned_at is null;
