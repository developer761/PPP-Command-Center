-- Migration 188: per-workspace office location and service area.
--
-- From Kate's workspace notes, 2026-09-02. Closes a live customer-facing
-- defect: the default agent config says the office is in Pasadena and that we
-- serve greater Los Angeles, because CA LA was the only campaign exported. A
-- Nassau customer asking where the office is would have been told Pasadena.
--
-- Only what Kate documented is seeded. Where she listed no office — NJ Meta,
-- CT, Colorado — the column stays NULL and the agent falls back to the service
-- area line rather than naming a city nobody confirmed. Inventing one is how a
-- customer gets sent to an address that does not exist.
--
-- NOT seeded, deliberately:
--   Google LSA and every AM- workspace run NO AI BOT. They are human-only, so
--   giving them a bot configuration would create the impression one is running.
--
-- Safe to re-run.

INSERT INTO public.sms_agent_configs (workspace_id, office_location, service_area_note)
SELECT w.id, v.office, v.area
  FROM (VALUES
    -- New York — every workspace answers Garden City
    ('NY LI Nassau Leads',  'Garden City', 'We serve the majority of the area.'),
    ('NY LI Suffolk Leads', 'Garden City', 'We serve the majority of the area.'),
    ('NY NYC Leads',        'Garden City', 'We serve the majority of the area.'),
    ('NY Queens Leads',     'Garden City', 'We serve the majority of the area.'),
    ('NY Wstch Leads',      'Garden City', 'We serve the majority of the area.'),
    ('NY LI Meta',          'Garden City', 'We serve the majority of the area.'),
    ('NYC Meta',            'Garden City', 'We serve the majority of the area.'),
    -- New Jersey. NJ Meta has no office documented, so it stays NULL.
    ('NJ Leads',            'Piscataway',  'We serve the majority of the area.'),
    ('NJ Meta',             NULL,          'We serve the majority of the area.'),
    -- Florida
    ('FL Broward Leads',    'Coral Gables','We serve the majority of the area.'),
    ('FL Miami Leads',      'Coral Gables','We serve the majority of the area.'),
    ('SoFlo Meta',          'Coral Gables','We serve the majority of the area.'),
    -- Later phases, seeded now so switching a region on is a flag flip.
    ('CA LA Leads',         'Pasadena',    'We serve the majority of the greater Los Angeles and Orange County area.'),
    ('CA Meta',             'Pasadena',    'We serve the majority of the greater Los Angeles, Orange County, and San Diego areas.'),
    ('CA San Diego Leads',  'Pasadena',    'We serve the majority of the San Diego area.'),
    ('CO Denver Leads',     NULL,          'We serve the Denver metro area.'),
    ('CT Leads',            NULL,          'We serve the majority of the area.'),
    ('WC CT Meta',          NULL,          'We serve the majority of the area.')
  ) AS v(ws_name, office, area)
  JOIN public.sms_sub_accounts w ON w.name = v.ws_name
ON CONFLICT (workspace_id) WHERE workspace_id IS NOT NULL
DO UPDATE SET
  office_location   = EXCLUDED.office_location,
  service_area_note = EXCLUDED.service_area_note,
  updated_at        = NOW();

-- Record which workspaces are human-only, so nobody later wonders why they
-- have no bot configuration.
UPDATE public.sms_sub_accounts
   SET notes = COALESCE(NULLIF(notes, '') || ' ', '') || 'NO AI BOT — human-only workspace (Kate, 2026-09-02).'
 WHERE (name LIKE 'AM - %' OR name = 'Google LSA')
   AND COALESCE(notes, '') NOT LIKE '%NO AI BOT%';
