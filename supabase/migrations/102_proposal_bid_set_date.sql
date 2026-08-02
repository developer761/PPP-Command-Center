-- R1c: Bid Set date shown on the proposal. NULL = hide the line.
ALTER TABLE commercial_proposals ADD COLUMN IF NOT EXISTS bid_set_date date;
