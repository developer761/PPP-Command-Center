-- Migration 012: atomic increment RPC for snapshot_generation
--
-- The read-then-write bumpGeneration pattern in lib/salesforce/queries.ts
-- is non-atomic — two concurrent writebacks could both read the same value
-- and both write +1, losing one bump. At PPP's scale (1-2 writebacks/min
-- max) the race is rare, but the fix is cheap: wrap the increment in a
-- single-statement function that runs as a transaction.
--
-- Safe to paste-run multiple times; CREATE OR REPLACE is idempotent.

CREATE OR REPLACE FUNCTION bump_snapshot_generation()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE next_gen bigint;
BEGIN
  -- Single atomic UPDATE — no read-then-write race possible.
  UPDATE snapshot_generation
  SET generation = generation + 1,
      updated_at = now()
  WHERE key = 'global'
  RETURNING generation INTO next_gen;

  -- If the row didn't exist (migration 011 not run or row deleted), seed it.
  IF next_gen IS NULL THEN
    INSERT INTO snapshot_generation (key, generation)
    VALUES ('global', 1)
    ON CONFLICT (key) DO UPDATE SET generation = snapshot_generation.generation + 1
    RETURNING generation INTO next_gen;
  END IF;

  RETURN next_gen;
END;
$$;
