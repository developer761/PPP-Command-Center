-- Migration 197: what we cover, per workspace.
--
-- Karan, 2026-09-09: "each workspace also has certain things we cover vs not
-- cover in a certain workspace... the main chatbot should only have what we
-- cover everywhere."
--
-- THE BUG THIS REPLACES. "What we cover" is prose in sms_agent_configs, and
-- the three tiers RESOLVE BY REPLACEMENT: the moment a workspace is given its
-- own copy it stops following the global one entirely. Add a service to the
-- default a month later and that workspace silently never gets it. Two prose
-- blobs that are supposed to agree eventually do not, and nothing detects it.
--
-- A LIST, NOT MORE PROSE. Services are a set of discrete things, so they are
-- stored as a set. That makes "which workspaces do flooring" a question with
-- an answer, lets the prompt be GENERATED from the toggles so what the bot
-- says cannot drift from what the screen shows, and means adding a service
-- reaches every workspace that has not deliberately opted out.
--
-- ONLY DIFFERENCES ARE STORED. A workspace with no row for a service inherits
-- the default. That is what makes the global list mean "everywhere" — it is
-- the baseline, and a workspace row is an exception to it.
--
-- WHAT IS NOT HERE, DELIBERATELY. The never-anywhere list — bathtubs,
-- appliances, vehicles, industrial equipment, pool liners, murals, standalone
-- furniture — is NOT per workspace and is not in this table. It is enforced in
-- code by the post-filter in agent-output.ts, so a workspace could not opt
-- into bathtubs even if a row here said so: the reply would still be blocked.
-- Somewhere that looks like it can grant something it cannot is worse than no
-- screen at all.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_services (
  key                TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  -- How the bot should say it when listing what we do.
  phrase             TEXT NOT NULL,
  -- TRUE means every workspace offers it unless one says otherwise.
  covered_by_default BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order         SMALLINT NOT NULL DEFAULT 100,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sms_workspace_services (
  workspace_id UUID NOT NULL REFERENCES public.sms_sub_accounts(id) ON DELETE CASCADE,
  service_key  TEXT NOT NULL REFERENCES public.sms_services(key) ON DELETE CASCADE,
  -- The exception. A row exists ONLY where this workspace differs from the
  -- default, so the absence of a row is not missing data — it is agreement.
  covered      BOOLEAN NOT NULL,
  note         TEXT,
  updated_by   UUID,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, service_key)
);

CREATE INDEX IF NOT EXISTS sms_workspace_services_ws_idx
  ON public.sms_workspace_services (workspace_id);

COMMENT ON TABLE public.sms_workspace_services IS
  'Per-workspace exceptions to sms_services.covered_by_default. A missing row means the workspace follows the default. Migration 197.';

-- ── Kate's list ────────────────────────────────────────────────────────
-- Verbatim from PPP's live prompt: "Interior and exterior painting, lime
-- washing, skim coating, flooring, drywall, power washing, and wallpaper."
-- All default TRUE, because the global set is what we cover everywhere and
-- workspaces subtract from it.
INSERT INTO public.sms_services (key, label, phrase, covered_by_default, sort_order) VALUES
  ('interior_painting', 'Interior painting', 'interior painting',       TRUE, 10),
  ('exterior_painting', 'Exterior painting', 'exterior painting',       TRUE, 20),
  ('lime_washing',      'Lime washing',      'lime washing',            TRUE, 30),
  ('skim_coating',      'Skim coating',      'skim coating',            TRUE, 40),
  ('flooring',          'Flooring',          'flooring',                TRUE, 50),
  ('drywall',           'Drywall',           'drywall',                 TRUE, 60),
  ('power_washing',     'Power washing',     'power washing',           TRUE, 70),
  ('wallpaper',         'Wallpaper',         'wallpaper',               TRUE, 80),
  ('cabinet_refinish',  'Cabinet refinishing', 'kitchen and bathroom cabinet refinishing', TRUE, 90),
  ('minor_repairs',     'Minor repairs',     'minor repairs',           TRUE, 100)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.sms_services            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_workspace_services  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_services_no_client           ON public.sms_services;
DROP POLICY IF EXISTS sms_workspace_services_no_client ON public.sms_workspace_services;
-- Server-side only, like every other messaging table. The anon key is public.
CREATE POLICY sms_services_no_client           ON public.sms_services           FOR ALL USING (FALSE);
CREATE POLICY sms_workspace_services_no_client ON public.sms_workspace_services FOR ALL USING (FALSE);
