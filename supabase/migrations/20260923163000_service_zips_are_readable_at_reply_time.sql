-- PPP's serviced zips, where the reply path can read them.
--
-- A2: "Validate the zip against the service area BEFORE promising coverage."
-- The lookup itself has been right for a while, and it runs in exactly one
-- place: lead intake. A zip the customer gives MID-CONVERSATION is never
-- checked, which is the case that matters, because the zip on the record goes
-- stale. One of Kate's own findings is a customer giving a New Jersey address
-- while FL 33308 sat on the lead.
--
-- ── WHY A TABLE RATHER THAN A LOOKUP AT REPLY TIME ──────────────────────
--
-- The 2,194 Zip_Code__c rows only ever existed in a module-level cache inside
-- the poll process, so nothing outside that process could see them. The
-- obvious fix is to ask Salesforce when we need it. That is the wrong fix,
-- for two reasons.
--
-- The tick deliberately isolates Salesforce: the poll, the exit sweep and the
-- opt-out writeback each sit in their own try so that Salesforce being down
-- never stops replies going out. Putting a SOQL query in the reply path would
-- undo that on purpose.
--
-- And loadZipMap returns an EMPTY MAP when the query fails, by design, so a
-- blip does not mean an hour of routing without the map. At intake that is
-- safe, because an unresolvable zip goes to a human for triage. In a reply it
-- is not: an empty map makes every zip unserviceable, and the bot would tell
-- a real customer we do not cover them. That is the exact harm A2 exists to
-- prevent, caused by the check meant to prevent it.
--
-- So the poll writes what it already fetched, and the reply path reads our own
-- database. No extra load on Salesforce; the rows were being thrown away.
--
-- ── THE HONEST COST ─────────────────────────────────────────────────────
--
-- This is a copy of somebody else's system of record and it can drift. The
-- mitigation is refreshed_at: a reader that finds the newest row older than
-- its own threshold must answer UNKNOWN rather than trusting it, and unknown
-- routes to a person. Stale data that knows it is stale is safe. Stale data
-- that does not is how a customer gets told the wrong thing confidently.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.sms_service_zips (
  -- Five digits. Salesforce holds "11024" and leads arrive as "11024-1234",
  -- so the plus-four is dropped before it ever gets here.
  zip               TEXT PRIMARY KEY CHECK (zip ~ '^[0-9]{5}$'),
  state             TEXT,
  city              TEXT,
  county            TEXT,
  territory_name    TEXT,
  -- Service_Territory__r.IsActive. NOT Marketing_Active__c, which is not a
  -- serviceability test and has no column here for the same reason it has no
  -- field in territory.ts: a column nobody can read is a rule nobody can
  -- break.
  territory_active  BOOLEAN NOT NULL DEFAULT FALSE,
  -- When the poll last confirmed this row against Salesforce. The staleness
  -- guard reads it, so it is NOT NULL and defaulted.
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The reader asks two questions: one zip by primary key, and "how fresh is
-- this table" for the staleness guard. The second is a max() over the whole
-- table, which wants an index of its own.
CREATE INDEX IF NOT EXISTS sms_service_zips_refreshed_at_idx
  ON public.sms_service_zips (refreshed_at DESC);

COMMENT ON TABLE public.sms_service_zips IS
  'A2: PPP''s Zip_Code__c rows, written by the lead poll so the reply path can validate a zip without touching Salesforce. A copy, not the source. Read refreshed_at before trusting a row.';
COMMENT ON COLUMN public.sms_service_zips.territory_active IS
  'Service_Territory__r.IsActive. Marketing_Active__c is deliberately absent: it is not a serviceability test.';
COMMENT ON COLUMN public.sms_service_zips.refreshed_at IS
  'When the poll last saw this row in Salesforce. A reader that finds this stale must answer UNKNOWN, never "not serviced".';
