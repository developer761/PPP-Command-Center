-- PPP's fiscal year starts in FEBRUARY.
--
-- FY26 = 2026-02-01 → 2027-01-31; quarters Q1 Feb–Apr · Q2 May–Jul ·
-- Q3 Aug–Oct · Q4 Nov–Jan (AGENTS.md, and the shared ppp-salesforce-reference
-- BUSINESS_RULES.md). The setting was seeded at 1 (January) in migration 019
-- and never changed — there is no screen that writes it — so every "This year"
-- in the platform has been a calendar year.
--
-- It matters now because the Commercial dashboard's period picker (Katie
-- 2026-10-15, for Alex) defaults to "This FY" and offers fiscal quarters. With
-- 1 here, "This FY" would read Jan → today and "Q3" would be Jul–Sep: dates
-- nobody at PPP reports on.
--
-- Also moves the Estimator report's "This year" / "Last year" onto the fiscal
-- year, which is what its comment in presets.ts says it was always meant to do.
--
-- Takes effect within the settings cache's 1h TTL, or on the next deploy.
-- Safe to re-run. Undo: set the value back to '1'.

UPDATE public.commercial_settings
   SET value = '2'::JSONB,
       updated_at = now()
 WHERE key = 'fiscal_year_start_month';

INSERT INTO public.commercial_settings (key, value, description)
VALUES ('fiscal_year_start_month', '2'::JSONB, 'Month (1-12) the commercial fiscal year starts')
ON CONFLICT (key) DO NOTHING;
