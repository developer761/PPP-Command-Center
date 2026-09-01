-- Migration 182: seed the 32 Hatch workspaces.
--
-- Every workspace is seeded as a row, including the five Hatch marks inactive
-- and the regions PPP is not starting with. Turning a region on is then a flag
-- flip rather than a deploy — which is the whole reason is_active exists.
--
-- PHASE 1 = NY, NJ, FL (Karan 2026-09-01). Sixteen workspaces, and all three
-- states sit in America/New_York, so the first phase runs in ONE timezone. The
-- four-zone quiet-hours problem (CA / CO / TX) arrives only when those regions
-- switch on, which is a real de-risking of the riskiest rule in the system.
--
-- Numbers are from PPP's 4/2026 workspace inventory. Two caveats recorded in
-- the notes column rather than silently resolved:
--   * "FL Miami" in the inventory vs "FL Miami Leads" live. Same 786 Miami
--     area code, so almost certainly a rename — but it is an assumption.
--   * Thumbtack has NO number in the inventory at all. Seeded numberless
--     rather than invented.
-- Not seeded here: WC CT Meta and TX Meta 2, whose inventory names are
-- "WC CT Leads" and "TX Meta". Leads and Meta are different SOURCE buckets in
-- PPP's own naming, so treating one as the other could route a lead to the
-- wrong area code. Both are out of Phase 1 anyway.
--
-- Idempotent: ON CONFLICT (name) refreshes the number/timezone/flags but never
-- clobbers autosend_enabled, which is earned per workspace and must not be
-- reset by re-running a seed.

INSERT INTO public.sms_sub_accounts
  (name, phone_e164, time_zone, is_active, hatch_workspace_name, notes)
VALUES
  -- ── PHASE 1: New York ──────────────────────────────────────────────
  ('NY LI Nassau Leads',    '+15163448418', 'America/New_York', TRUE,  'NY LI Nassau Leads',    NULL),
  ('NY LI Suffolk Leads',   '+16315276864', 'America/New_York', TRUE,  'NY LI Suffolk Leads',   NULL),
  ('NY NYC Leads',          '+19293352212', 'America/New_York', TRUE,  'NY NYC Leads',          NULL),
  ('NY Queens Leads',       '+13476577035', 'America/New_York', TRUE,  'NY Queens Leads',       NULL),
  ('NY Wstch Leads',        '+19144156860', 'America/New_York', TRUE,  'NY Wstch Leads',        NULL),
  ('NY LI Meta',            '+15165852881', 'America/New_York', TRUE,  'NY LI Meta',            NULL),
  ('NYC Meta',              '+19295656501', 'America/New_York', TRUE,  'NYC Meta',              NULL),
  ('AM - NY',               '+15167885933', 'America/New_York', TRUE,  'AM - NY',               'Account-management surface, separate from call-centre traffic.'),
  -- ── PHASE 1: New Jersey ────────────────────────────────────────────
  ('NJ Leads',              '+12019039790', 'America/New_York', TRUE,  'NJ Leads',              NULL),
  ('NJ Meta',               '+19733709440', 'America/New_York', TRUE,  'NJ Meta',               NULL),
  ('AM - NJ',               '+19733135123', 'America/New_York', TRUE,  'AM - NJ',               'Account-management surface.'),
  -- ── PHASE 1: Florida ───────────────────────────────────────────────
  ('FL Broward Leads',      '+19544194564', 'America/New_York', TRUE,  'FL Broward Leads',      NULL),
  ('FL Miami Leads',        '+17868768407', 'America/New_York', TRUE,  'FL Miami',              'Number listed as "FL Miami" in the 4/2026 inventory; 786 is Miami, so read as a rename. CONFIRM.'),
  ('SoFlo Meta',            '+17545474310', 'America/New_York', TRUE,  'SoFlo Meta',            'South Florida.'),
  ('AM - SoFlo',            '+17868412015', 'America/New_York', TRUE,  'AM - SoFlo',            'Account-management surface, South Florida.'),
  -- ── Source-based, NOT region-scoped. See the note. ─────────────────
  ('Google LSA',            '+15162269404', 'America/New_York', FALSE, 'Google LSA',            'Source workspace, not a region. 516 is Nassau, but it may carry Google LSA leads for EVERY state — if so it cannot be switched on with a NY/NJ/FL-only phase. CONFIRM before activating.'),
  ('Thumbtack',             NULL,           'America/New_York', FALSE, 'Thumbtack',             'No number in the 4/2026 inventory. Does this workspace send at all? CONFIRM.'),

  -- ── Later phases: Connecticut ──────────────────────────────────────
  ('CT Leads',              '+14758897507', 'America/New_York', FALSE, 'CT Leads',              NULL),
  ('AM - CT',               '+14754471692', 'America/New_York', FALSE, 'AM - CT',               'Account-management surface.'),
  ('WC CT Meta',            NULL,           'America/New_York', FALSE, 'WC CT Meta',            'Inventory lists "WC CT Leads" at 914-601-3937. Leads vs Meta are different source buckets, so NOT assumed to be the same workspace. CONFIRM.'),
  -- ── Later phases: California ───────────────────────────────────────
  ('CA LA Leads',           '+13235290930', 'America/Los_Angeles', FALSE, 'CA LA Leads',        NULL),
  ('CA San Diego Leads',    '+18587790696', 'America/Los_Angeles', FALSE, 'CA San Diego Leads', NULL),
  ('CA Meta',               '+12132972592', 'America/Los_Angeles', FALSE, 'CA Meta',            NULL),
  ('AM - CA LA',            '+13235533840', 'America/Los_Angeles', FALSE, 'AM - CA LA',         'Account-management surface.'),
  -- ── Later phases: Colorado / Texas ─────────────────────────────────
  ('CO Denver Leads',       '+17206193724', 'America/Denver',  FALSE, 'CO Denver Leads',       NULL),
  ('AM - Dallas TX',        '+14699666656', 'America/Chicago', FALSE, 'AM - Dallas TX',        'Account-management surface.'),
  ('TX Meta 2',             NULL,           'America/Chicago', FALSE, 'TX Meta 2',             'Inventory lists "TX Meta" at 469-833-3951. The "2" suffix is unexplained — rename, or a second number? CONFIRM.'),

  -- ── Inactive in Hatch. Rows exist so switching one on is a flag. ────
  ('Elevate Paint Co',      NULL, 'America/New_York',    FALSE, 'Elevate Paint Co - inactive',      'Inactive in Hatch. Separate brand under the PPP umbrella — would need its own voice and branding.'),
  ('FL Orlando Leads',      NULL, 'America/New_York',    FALSE, 'FL Orlando Leads - Inactive',      'Inactive in Hatch.'),
  ('LA Baton Rouge Leads',  NULL, 'America/Chicago',     FALSE, 'LA Baton Rouge Leads - Inactive',  'Inactive in Hatch.'),
  ('NC Leads',              NULL, 'America/New_York',    FALSE, 'NC Leads - Inactive',              'Inactive in Hatch.'),
  ('TX Dallas Leads',       NULL, 'America/Chicago',     FALSE, 'TX Dallas Leads - Inactive',       'Inactive in Hatch.')
ON CONFLICT (name) DO UPDATE SET
  phone_e164           = EXCLUDED.phone_e164,
  time_zone            = EXCLUDED.time_zone,
  is_active            = EXCLUDED.is_active,
  hatch_workspace_name = EXCLUDED.hatch_workspace_name,
  notes                = EXCLUDED.notes,
  updated_at           = NOW();
-- autosend_enabled is deliberately NOT in the UPDATE list: it is earned per
-- workspace after a clean draft-for-review run, and re-running a seed must not
-- quietly hand a workspace permission to text people unsupervised.
