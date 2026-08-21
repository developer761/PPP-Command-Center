-- 165 · Compact proposal PDF. (Stephanie, 2026-08-17)
--
-- HER NOTE: "Can we find a way to put it all on one page or an option to change
-- the format if needed, ie, font size and spacing. Also, if it needs to spill
-- over onto 2 pages can we add page numbers to the bottom."
--
-- Page numbers already print when the document runs past one page. This is the
-- other half: a per-proposal density switch for the job that lands two lines
-- onto a second sheet.
--
-- PER PROPOSAL, not a global setting. Most proposals fit and should keep the
-- letterhead's normal type size — a platform-wide shrink would make every
-- document harder to read to fix the occasional long one. The estimator who
-- can see it spilling is the one who should decide.
--
-- Compact is a TYPOGRAPHIC change only: smaller body type and tighter leading
-- and section gaps. It never drops content, because a proposal that quietly
-- omits an exclusion to fit the page is worse than a proposal on two pages.

ALTER TABLE commercial_proposals
  ADD COLUMN IF NOT EXISTS pdf_compact boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN commercial_proposals.pdf_compact IS
  'Render this proposal with tighter type + spacing to fit fewer pages. Typography only — never drops content.';
