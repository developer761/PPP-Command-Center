-- A submittal revision could never be saved.
--
-- `createOpportunitySubmittal` says, in its own docblock, what a revision is:
--
--     If revises_submittal_id is set, this row is a revision of the parent:
--       - revision_number   = parent.revision_number + 1
--       - submittal_number  = parent.submittal_number   (keeps the package ID)
--
-- Keeping the package ID is correct and is the whole point — a GC holding
-- SUB-001 gets SUB-001 Rev 2, not a new number. But the unique index created
-- alongside it in migration 041 is:
--
--     (opportunity_id, submittal_number)
--
-- with no revision_number in it. So the revision insert collides with its own
-- parent, every time, and comes back as a raw Postgres duplicate-key error:
--
--     duplicate key value violates unique constraint
--     "commercial_opp_submittals_opp_num_uniq"
--
-- Stephanie's handbook lists "+ Create revision" as a control and tells her
-- when to use it: "After a revise or reject — starts the next round, numbered
-- Rev 2." It has never worked. Nobody has hit it because Tomco have raised no
-- submittals yet (0 rows on 2026-09-25) — it was waiting for the first job to
-- come back "Revise & Resubmit", which is the ordinary path, not an edge case.
--
-- Found by scripts/check-delivery-flows.mjs on its first run. No unit test
-- could have: the rule lives in an index, and the suite has no database.
--
-- THE RULE, corrected: a package revision is unique, not a package. Two rows
-- may share submittal_number 1 as long as they are different revisions of it;
-- two rows may never share both.
--
-- HOW THE OLD INDEX IS DROPPED
--
-- Two ways, belt and braces, and neither compares arrays.
--
-- The first cut matched the index by aggregating its column names and
-- comparing to array['opportunity_id','submittal_number']. `pg_attribute.attname`
-- is of type `name`, so that aggregate is `name[]` and Postgres refused it:
--
--     ERROR: 42883: operator does not exist: name[] = text[]
--
-- 1. BY NAME. Safe here because 041 names this index explicitly and the name is
--    38 characters — well under the 63 at which Postgres truncates. The earlier
--    lesson about never dropping by a guessed name applies to names Postgres
--    GENERATES, which is not this.
--
-- 2. BY DEFINITION, as a net for any environment where it was created under a
--    different name. `pg_get_indexdef` renders the column list at the end of
--    the statement, so a plain LIKE on that ending is enough — no casts, no
--    array comparison, and the new three-column index cannot match it.

drop index if exists public.commercial_opp_submittals_opp_num_uniq;

do $$
declare
  ix record;
begin
  for ix in
    select i.relname as idxname
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'commercial_opp_submittals'
       and x.indisunique
       and pg_get_indexdef(x.indexrelid) like '%(opportunity_id, submittal_number)'
  loop
    execute format('drop index if exists public.%I', ix.idxname);
    raise notice 'dropped unique index % on (opportunity_id, submittal_number)', ix.idxname;
  end loop;
end $$;

create unique index if not exists commercial_opp_submittals_opp_num_rev_uniq
  on public.commercial_opp_submittals (opportunity_id, submittal_number, revision_number);

comment on index public.commercial_opp_submittals_opp_num_rev_uniq is
  'One row per package REVISION. A revision reuses its parent submittal_number (the GC keeps the package ID), so revision_number has to be part of the key or Create revision collides with its own parent.';
