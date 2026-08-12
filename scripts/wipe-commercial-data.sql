-- ═══════════════════════════════════════════════════════════════════════════
--  ⛔  DESTRUCTIVE. THIS DELETES EVERY COMMERCIAL ACCOUNT, DEAL AND PROJECT.
--
--  This is NOT a migration. It is never run automatically and must never be
--  added to supabase/migrations/. It exists so the platform can be handed to
--  Tomco with a clean slate after testing.
--
--  Run it only when you intend to lose every account, opportunity, project,
--  proposal, invoice, change order, payment application, submittal, work
--  order, closeout package, purchase and crew schedule in the commercial
--  platform. There is no undo.
--
--  Karan 2026-08-12: run once to clear test data before Tomco go-live.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  KEPT — configuration you set up, not job data:
--    products · customer prices · exclusions · settings · operating company
--    tax jurisdictions · competitors · teams · team members · user roles
--    employees · employee rates · crews · crew members · pay periods
--    notification rules · email prefs · Slack links · audit log
--
--  All-or-nothing: the whole thing runs in one transaction, so a failure
--  part-way leaves the database exactly as it was.

BEGIN;

-- ── Invoice tree ───────────────────────────────────────────────────────────
DELETE FROM public.commercial_invoice_line_items;
DELETE FROM public.commercial_invoice_payments;
DELETE FROM public.commercial_invoice_attachments;
DELETE FROM public.commercial_invoice_milestones;
DELETE FROM public.commercial_invoice_status_log;
DELETE FROM public.commercial_invoices;

-- ── AIA / payment applications ─────────────────────────────────────────────
DELETE FROM public.commercial_aia_line_items;
DELETE FROM public.commercial_aia_applications;

-- ── Change orders ──────────────────────────────────────────────────────────
DELETE FROM public.commercial_change_order_attachments;
DELETE FROM public.commercial_change_orders;

-- ── Closeout ───────────────────────────────────────────────────────────────
DELETE FROM public.commercial_closeout_items;
DELETE FROM public.commercial_closeout_packages;

-- ── Submittals ─────────────────────────────────────────────────────────────
DELETE FROM public.commercial_opp_submittal_items;
DELETE FROM public.commercial_opp_submittal_status_log;
DELETE FROM public.commercial_opp_submittals;

-- ── Proposals ──────────────────────────────────────────────────────────────
DELETE FROM public.commercial_proposal_line_items;
DELETE FROM public.commercial_proposal_email_sends;
DELETE FROM public.commercial_proposals;

-- ── Costs + work orders ────────────────────────────────────────────────────
DELETE FROM public.commercial_project_purchases;
DELETE FROM public.commercial_work_orders;

-- ── Field Ops: hours, shifts, scheduling ───────────────────────────────────
-- Employees, crews and pay rates SURVIVE — only the work they were assigned to
-- on test jobs is removed.
DELETE FROM public.commercial_time_entries;
DELETE FROM public.commercial_time_punches;
DELETE FROM public.commercial_absences;
DELETE FROM public.commercial_assignments;
DELETE FROM public.commercial_job_phases;
DELETE FROM public.commercial_schedule_email_recipients;
DELETE FROM public.commercial_schedule_email_log;
DELETE FROM public.commercial_jobs;

-- ── Projects (must precede opportunities — the FK is ON DELETE RESTRICT) ────
DELETE FROM public.commercial_projects;

-- ── Opportunity tree ───────────────────────────────────────────────────────
DELETE FROM public.commercial_opportunity_notes;
DELETE FROM public.commercial_opportunity_tasks;
DELETE FROM public.commercial_opportunity_attachments;
DELETE FROM public.commercial_opportunity_status_log;
DELETE FROM public.commercial_opportunity_assignments;
DELETE FROM public.commercial_win_loss_debrief;
DELETE FROM public.commercial_opp_finishes;
DELETE FROM public.commercial_opportunities;

-- ── Account tree ───────────────────────────────────────────────────────────
DELETE FROM public.commercial_account_contacts;
DELETE FROM public.commercial_account_notes;
DELETE FROM public.commercial_account_tags;
DELETE FROM public.commercial_account_documents;
DELETE FROM public.commercial_account_assignments;
DELETE FROM public.commercial_account_deal_counter;
DELETE FROM public.commercial_contacts;
DELETE FROM public.commercial_accounts;

-- ── Loose ends ─────────────────────────────────────────────────────────────
DELETE FROM public.commercial_documents;
DELETE FROM public.commercial_archived_emails;
DELETE FROM public.commercial_notification_rule_fires;

-- Restart deal numbering. Without this the first real Tomco job would be
-- 2026-0024 and look like there were twenty-three before it.
DELETE FROM public.commercial_project_number_counters;

COMMIT;

-- ── Confirm ────────────────────────────────────────────────────────────────
SELECT 'accounts'      AS table, count(*) FROM public.commercial_accounts
UNION ALL SELECT 'opportunities', count(*) FROM public.commercial_opportunities
UNION ALL SELECT 'projects',      count(*) FROM public.commercial_projects
UNION ALL SELECT 'proposals',     count(*) FROM public.commercial_proposals
UNION ALL SELECT 'invoices',      count(*) FROM public.commercial_invoices
UNION ALL SELECT 'work orders',   count(*) FROM public.commercial_work_orders
UNION ALL SELECT 'field ops jobs',count(*) FROM public.commercial_jobs
UNION ALL SELECT '— products kept',   count(*) FROM public.commercial_products
UNION ALL SELECT '— exclusions kept', count(*) FROM public.commercial_exclusions
UNION ALL SELECT '— employees kept',  count(*) FROM public.commercial_employees;
