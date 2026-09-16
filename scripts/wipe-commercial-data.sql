-- Wipe the Commercial platform's TRANSACTIONAL data, before the Tomco
-- migration (Katie 2026-09-15: "Clear out all the test data").
--
-- Paste the whole file into the Supabase SQL editor. It runs in ONE
-- transaction: either every table below is emptied or nothing is.
--
-- WHAT IT KEEPS — the setup Tomco needs on the other side:
--   commercial_operating_company      · who we are on every document
--   commercial_vendors                · the 44 vendors imported from Salesforce
--   commercial_products               · the price book
--   commercial_exclusions             · the proposal exclusions library
--   commercial_tax_jurisdictions      · sales-tax by ZIP
--   commercial_account_rating_labels  · A/B/C labels
--   commercial_settings               · settings (minus the one key below)
--   commercial_user_roles, _user_email_prefs
--   commercial_teams, _team_members   · "Tomco Suffolk" (see the note below)
--   commercial_notification_rules     · custom alert rules
--   commercial_report_folders/_items/_members · Manager / Finance / Field Users
--   commercial_audit_log              · the record of what was done, kept on purpose
--   profiles + auth users             · everybody's logins
--
-- WHAT IT CANNOT DO: Storage files. SQL cannot reach the buckets — run
-- scripts/wipe-commercial-storage.mjs afterwards for the ~59 uploaded files.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed 2026-09-15, after reading it against the live schema:
--
--   1. ORDER. It deleted commercial_work_orders BEFORE commercial_jobs, and
--      `commercial_jobs.work_order_id` references work orders with no ON DELETE
--      rule (migration 112). Every live job points at one, so the very first
--      real run would have hit a foreign-key error and rolled the whole thing
--      back. Field Ops now goes first.
--   2. MISSING TABLES. commercial_opportunity_contacts, the signature tables,
--      commercial_receivable_notes, the crew/employee tables, and the
--      commercial_* rows in the shared notifications table were all left
--      behind — rows pointing at records that no longer exist.
--   3. THE SIGNATURE TRAIL GUARD. commercial_signature_events refuses DELETE
--      (it is an audit trail). The cascade from proposals reaches it, so
--      without the opt-out below the wipe cannot run at all.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- The e-signature trail is append-only by design; this is the deliberate
-- opt-out, and it lasts only for this transaction.
SET LOCAL commercial.allow_signature_event_delete = 'on';

-- 1. E-signature (before the proposals they hang off).
DELETE FROM public.commercial_signature_events;
DELETE FROM public.commercial_signature_requests;

-- 2. Invoices + payments.
DELETE FROM public.commercial_invoice_line_items;
DELETE FROM public.commercial_invoice_payments;
DELETE FROM public.commercial_invoice_attachments;
DELETE FROM public.commercial_invoice_milestones;
DELETE FROM public.commercial_invoice_status_log;
DELETE FROM public.commercial_invoices;

-- 3. AIA billing.
DELETE FROM public.commercial_aia_line_items;
DELETE FROM public.commercial_aia_applications;

-- 4. Change orders, closeout, submittals.
DELETE FROM public.commercial_change_order_attachments;
DELETE FROM public.commercial_change_orders;
DELETE FROM public.commercial_closeout_items;
DELETE FROM public.commercial_closeout_packages;
DELETE FROM public.commercial_opp_submittal_items;
DELETE FROM public.commercial_opp_submittal_status_log;
DELETE FROM public.commercial_opp_submittals;

-- 5. Proposals.
DELETE FROM public.commercial_proposal_line_items;
DELETE FROM public.commercial_proposal_email_sends;
DELETE FROM public.commercial_proposals;

-- 6. Field Ops — BEFORE work orders: commercial_jobs.work_order_id references
--    a work order and does not cascade.
DELETE FROM public.commercial_time_entries;
DELETE FROM public.commercial_time_punches;
DELETE FROM public.commercial_absences;
DELETE FROM public.commercial_assignments;
DELETE FROM public.commercial_job_phases;
DELETE FROM public.commercial_schedule_email_recipients;
DELETE FROM public.commercial_schedule_email_log;
DELETE FROM public.commercial_jobs;

-- 7. Crews and employees. All five live rows are test people ("k m", Karan);
--    real crew arrives with the Tomco migration. Employee rates go with them.
DELETE FROM public.commercial_crew_members;
DELETE FROM public.commercial_crews;
DELETE FROM public.commercial_pay_periods;
DELETE FROM public.commercial_employee_rates;
DELETE FROM public.commercial_employees;

-- 8. Costs + work orders + projects.
DELETE FROM public.commercial_project_purchases;
DELETE FROM public.commercial_work_orders;
DELETE FROM public.commercial_projects;

-- 9. Opportunities.
DELETE FROM public.commercial_opportunity_contacts;
DELETE FROM public.commercial_opportunity_notes;
DELETE FROM public.commercial_opportunity_tasks;
DELETE FROM public.commercial_opportunity_attachments;
DELETE FROM public.commercial_opportunity_status_log;
DELETE FROM public.commercial_opportunity_assignments;
DELETE FROM public.commercial_win_loss_debrief;
DELETE FROM public.commercial_opp_finishes;
DELETE FROM public.commercial_opportunities;

-- 10. Accounts + contacts.
DELETE FROM public.commercial_account_contacts;
DELETE FROM public.commercial_account_notes;
DELETE FROM public.commercial_account_tags;
DELETE FROM public.commercial_account_documents;
DELETE FROM public.commercial_account_assignments;
DELETE FROM public.commercial_account_deal_counter;
DELETE FROM public.commercial_contacts;
DELETE FROM public.commercial_accounts;

-- 11. Documents index, archived email, counters, chase notes.
DELETE FROM public.commercial_documents;
DELETE FROM public.commercial_archived_emails;
DELETE FROM public.commercial_notification_rule_fires;
DELETE FROM public.commercial_receivable_notes;
DELETE FROM public.commercial_project_number_counters;

-- 12. Collection notes live in a settings KEY, not a table, and they are keyed
--     to invoice and AIA ids that are about to stop existing.
DELETE FROM public.commercial_settings WHERE key = 'commercial_receivable_row_notes';

-- 13. Bells and emails about records that will no longer exist. The
--     notifications table is SHARED with the residential Command Center, so
--     this touches only commercial_* kinds — never a residential row.
DELETE FROM public.notifications WHERE kind LIKE 'commercial\_%';

-- 14. Test teams and competitors. "Tomco Suffolk" (Brendan + Stephanie) is
--     real and stays; the others are leftovers. Comment these out to keep them.
DELETE FROM public.commercial_team_members
 WHERE team_id IN (SELECT id FROM public.commercial_teams WHERE name <> 'Tomco Suffolk');
DELETE FROM public.commercial_teams WHERE name <> 'Tomco Suffolk';
DELETE FROM public.commercial_competitors;

-- 15. The Salesforce import map. It says "this SF id became this row"; every
--     row it names has just been deleted. Leaving it would be worse than not
--     having it: the next import run reads the map, believes those rows still
--     exist, and UPDATEs ids that are gone instead of inserting the data.
DELETE FROM public.commercial_import_map;

COMMIT;

-- ─── Proof, not a promise: every line below must read 0. ─────────────────────
SELECT 'accounts'              AS what, count(*) AS rows FROM public.commercial_accounts
UNION ALL SELECT 'contacts',           count(*) FROM public.commercial_contacts
UNION ALL SELECT 'opportunities',      count(*) FROM public.commercial_opportunities
UNION ALL SELECT 'projects',           count(*) FROM public.commercial_projects
UNION ALL SELECT 'proposals',          count(*) FROM public.commercial_proposals
UNION ALL SELECT 'invoices',           count(*) FROM public.commercial_invoices
UNION ALL SELECT 'invoice payments',   count(*) FROM public.commercial_invoice_payments
UNION ALL SELECT 'AIA applications',   count(*) FROM public.commercial_aia_applications
UNION ALL SELECT 'change orders',      count(*) FROM public.commercial_change_orders
UNION ALL SELECT 'purchases',          count(*) FROM public.commercial_project_purchases
UNION ALL SELECT 'work orders',        count(*) FROM public.commercial_work_orders
UNION ALL SELECT 'field ops jobs',     count(*) FROM public.commercial_jobs
UNION ALL SELECT 'time entries',       count(*) FROM public.commercial_time_entries
UNION ALL SELECT 'employees',          count(*) FROM public.commercial_employees
UNION ALL SELECT 'documents',          count(*) FROM public.commercial_documents
UNION ALL SELECT 'signature requests', count(*) FROM public.commercial_signature_requests
UNION ALL SELECT 'signature events',   count(*) FROM public.commercial_signature_events
UNION ALL SELECT 'commercial bells',   count(*) FROM public.notifications WHERE kind LIKE 'commercial\_%'
UNION ALL SELECT 'SF import map',       count(*) FROM public.commercial_import_map

-- ─── And every line below must be NON-zero: the setup that had to survive. ──
UNION ALL SELECT '— vendors KEPT',        count(*) FROM public.commercial_vendors
UNION ALL SELECT '— products KEPT',       count(*) FROM public.commercial_products
UNION ALL SELECT '— exclusions KEPT',     count(*) FROM public.commercial_exclusions
UNION ALL SELECT '— tax zones KEPT',      count(*) FROM public.commercial_tax_jurisdictions
UNION ALL SELECT '— report folders KEPT', count(*) FROM public.commercial_report_folders
UNION ALL SELECT '— folder members KEPT', count(*) FROM public.commercial_report_folder_members
UNION ALL SELECT '— teams KEPT',          count(*) FROM public.commercial_teams
UNION ALL SELECT '— logins KEPT',         count(*) FROM public.profiles
UNION ALL SELECT '— audit log KEPT',      count(*) FROM public.commercial_audit_log;
