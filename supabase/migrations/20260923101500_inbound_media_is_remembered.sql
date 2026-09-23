-- The customer sent a photo, and nothing anywhere remembered it.
--
-- A26 (critical): "Acknowledge that a photo was received." Kate measured it:
-- "42 of 45 bot replies after a customer photo never mentioned it. Detection
-- is a build requirement; interpretation is not."
--
-- ── THE ACKNOWLEDGEMENT ALREADY EXISTED AND COULD NEVER FIRE ────────────
--
-- render.ts has said "Thanks for the photo!" since photos were built, keyed on
-- a mediaCount the renderer is handed. inbound.ts computes that count from the
-- webhook correctly. In between, sms_messages had nowhere to put it, so the
-- count was computed, used to decide the message was not empty, and thrown
-- away. The scheduler then read the message back some seconds later to run the
-- agent turn, found no media because there was nowhere for media to be, and
-- passed zero.
--
-- The only caller that has ever passed a real count is the simulator, which is
-- why this looked implemented and tested. It was neither, in production.
--
-- ── COUNT, NOT URLS ─────────────────────────────────────────────────────
--
-- We deliberately do not store the media URLs. inbound.ts already says why:
-- "We never fetch the media; that it EXISTS is what the rule needs." A26 asks
-- for one short line naming the photo and forbids going further — "do not
-- describe or price from it (the capability ceiling grants detection, not
-- interpretation)". Storing a count makes the required behaviour possible and
-- the forbidden behaviour impossible, which is the better shape. Carrier media
-- URLs also expire and are credential-bearing on some carriers, so keeping
-- them would be a liability in exchange for a capability we must not use.
--
-- A9's photo carve-out reads this too: a photo of the area sent with what they
-- want done CONFIRMS the scope, so no confirmation is required.
--
-- Safe to re-run.

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS media_count SMALLINT NOT NULL DEFAULT 0;

-- Nonsense counts are refused rather than stored. A negative count would make
-- "did a photo arrive" answer differently depending on how it was asked, and
-- an absurd one is a parsing bug worth failing on rather than acknowledging
-- four hundred photos to a customer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_messages_media_count_sane'
  ) THEN
    ALTER TABLE public.sms_messages
      ADD CONSTRAINT sms_messages_media_count_sane
      CHECK (media_count >= 0 AND media_count <= 50);
  END IF;
END $$;

COMMENT ON COLUMN public.sms_messages.media_count IS
  'A26: how many attachments arrived with this message. Detection only — the URLs are deliberately not stored, because the rule requires acknowledging a photo and forbids interpreting one.';
