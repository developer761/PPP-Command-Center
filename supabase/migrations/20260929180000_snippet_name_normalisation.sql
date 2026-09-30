-- THE INDEX AND THE RESOLVER HAVE TO AGREE ABOUT WHAT "THE SAME NAME" MEANS.
--
-- 20260929170000_snippets.sql indexed `lower(btrim(name))`. `btrim` strips
-- ASCII SPACE and nothing else — not a tab, not a newline, not a non-breaking
-- space. JavaScript's `.trim()` strips all of them, and resolveSnippets also
-- collapses inner runs.
--
-- So the two disagreed, and it is not theoretical: verified against the real
-- database on 2026-09-29, inserting "Availability" and "Availability\t" as
-- shared snippets both succeeded. Postgres saw two rows. resolveSnippets saw
-- one name twice and kept whichever came first.
--
-- The symptom is the worst kind: somebody writes a snippet, it saves without
-- complaint, it appears in the settings list, and it never shows up in the
-- composer — because another row with a name that LOOKS identical is winning.
-- Nothing errors and nothing is logged.
--
-- The expression below is the same normalisation resolveSnippets performs:
-- collapse every run of whitespace to one space, then trim, then lower. It is
-- IMMUTABLE (regexp_replace, btrim and lower all are), so it is indexable.
--
-- saveSnippet also normalises inner whitespace before writing, so the door
-- and the database agree; this index is what catches a row written by hand.

DROP INDEX IF EXISTS public.sms_snippets_one_per_name;
DROP INDEX IF EXISTS public.sms_snippets_one_shared_per_name;

CREATE UNIQUE INDEX IF NOT EXISTS sms_snippets_one_per_name
  ON public.sms_snippets (
    workspace_id,
    lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
  );

-- Still needed separately: Postgres treats NULLs as distinct in a unique
-- index, so the index above does not constrain the shared tier at all.
CREATE UNIQUE INDEX IF NOT EXISTS sms_snippets_one_shared_per_name
  ON public.sms_snippets (lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))))
  WHERE workspace_id IS NULL;

COMMENT ON TABLE public.sms_snippets IS
  'Reusable replies a person drops into a thread. HUMAN-facing, unlike '
  'sms_workspace_faqs which is bot-facing — a rep reads a snippet before '
  'sending it, so the content rules are lighter. Merge fields are filled '
  'before insertion so an unfillable one is caught while somebody is looking '
  'at the words rather than by the gate after they hit send. NULL '
  'workspace_id means every workspace. Name uniqueness normalises whitespace '
  'the same way resolveSnippets does — see 20260929180000.';
