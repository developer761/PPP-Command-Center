-- Internal-only proposal line items.
--
-- Brendan 2026-09-23: "Add an internal line item button on the proposal when
-- making the inclusions."
--
-- An internal line is real, priced scope that Tomco is doing and paying for —
-- lifts, night access, a dumpster — that they do not want itemised to the GC.
-- So it BEHAVES like any other inclusion except on the customer copy:
--
--   · it counts toward the TOTAL the customer is quoted (it is work they are
--     buying, and leaving it out would under-charge the job)
--   · it does NOT appear in the customer PDF's Inclusions list
--   · it DOES appear on the internal plan report, marked, so the estimator and
--     the approver can see what the number is made of
--
-- Default false, so every existing line is unchanged and every existing
-- proposal renders exactly as it does today.

alter table public.commercial_proposal_line_items
  add column if not exists is_internal boolean not null default false;

comment on column public.commercial_proposal_line_items.is_internal is
  'Priced scope hidden from the customer PDF but included in the TOTAL. Shows on the internal plan report only. Brendan 2026-09-23.';

-- Partial index: the proposals that HAVE internal lines are the rare ones, and
-- every render asks "are there any?" to decide whether to warn about per-line
-- prices not summing to the printed total.
create index if not exists commercial_proposal_line_items_internal_idx
  on public.commercial_proposal_line_items (proposal_id)
  where is_internal = true;
