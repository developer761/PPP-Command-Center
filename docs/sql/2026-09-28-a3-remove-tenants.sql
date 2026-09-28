-- Kate, 2026-09-28: "Yes, follow A6 + remove 'tenants' from A3"
--
-- A3's rule card lists "the tenants" among the phrases that establish a
-- commercial property. A6's card says the opposite in the same breath:
--
--   A3  '"We're a dentist's office", "our store", "the tenants", "our
--        building", "the office", "the restaurant" all establish it'
--   A6  'The words "co-op", "condo", "tenant" and "apartment" DO NOT fire
--        this gate and must never be treated as commercial signals — they
--        describe where someone lives.'
--
-- Both cards reach the model in the same prompt, every turn, so the bot has
-- been reading a contradiction. The CODE already follows A6 (offsite.ts,
-- NOT_COMMERCIAL is a veto), which is the reading Kate has now confirmed, so
-- this only brings her text into line with her answer and with what ships.
--
-- Idempotent: the WHERE clause makes a second run a no-op, and the REPLACE
-- targets the full three-phrase fragment rather than the bare word, so
-- nothing else in the card can be caught by it.
--
-- NOTE FOR WHOEVER RUNS IT: the rules table is imported from Kate's sheet and
-- nothing in the app writes to it. If the import runs again from a sheet that
-- still says "the tenants", this is reverted. Kate needs to make the same
-- edit in the sheet for it to stick.

UPDATE public.sms_class_a_rules
   SET rule_card = REPLACE(
         rule_card,
         '"our store", "the tenants", "our building"',
         '"our store", "our building"'
       ),
       updated_at = NOW()
 WHERE code = 'A3'
   AND rule_card LIKE '%"the tenants"%';

-- Expect: UPDATE 1 on the first run, UPDATE 0 on any run after it.
-- Check afterwards — this should return no rows:
--   SELECT code FROM public.sms_class_a_rules
--    WHERE code = 'A3' AND rule_card LIKE '%tenant%';
