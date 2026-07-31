-- 088 · Brand assets bucket (2026-08)
-- Private storage bucket for the operating company's logo/letterhead +
-- signature image (Phase 0B). Accessed server-side only (download → Buffer for
-- react-pdf); no public URLs. Idempotent.

INSERT INTO storage.buckets (id, name, public)
VALUES ('commercial-brand-assets', 'commercial-brand-assets', false)
ON CONFLICT (id) DO NOTHING;
