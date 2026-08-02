-- R1b: adjustable final price. NULL = use the line-item sum; a value overrides
-- the total. App validates >= 0. Flows INTO total_cents (contract number).
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS final_price_override_cents bigint;
