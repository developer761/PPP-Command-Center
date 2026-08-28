-- 172 — Mark read the bells that point at deleted records.
--
-- Deleting a deal or a GC cascades its invoices, purchases and Field Ops jobs.
-- It never touched notifications, so the bell kept unread items whose only
-- action was to open something that no longer exists: 77 of the 191 Commercial
-- notifications on this platform led nowhere, 29 of them unread and counting
-- toward the badge.
--
-- An unread count is a promise that there is something to do. A queue where two
-- in five items are dead ends is a queue people stop opening.
--
-- Marked READ, never deleted — the notification is a true record of something
-- that happened, it is just no longer actionable. History stays, the badge
-- doesn't. The code fix (lib/notifications/retire.ts, called from both
-- soft-delete cascades) stops new ones; this clears what is already there.

-- 1. Notifications whose link names a deleted OPPORTUNITY.
UPDATE notifications n
   SET read_at = now()
 WHERE n.read_at IS NULL
   AND n.link LIKE '/commercial/%'
   AND EXISTS (
     SELECT 1 FROM commercial_opportunities o
      WHERE o.deleted_at IS NOT NULL
        AND n.link LIKE '%' || o.id::text || '%'
   );

-- 2. …a deleted ACCOUNT (a proposal deep-link carries the account id too).
UPDATE notifications n
   SET read_at = now()
 WHERE n.read_at IS NULL
   AND n.link LIKE '/commercial/%'
   AND EXISTS (
     SELECT 1 FROM commercial_accounts a
      WHERE a.deleted_at IS NOT NULL
        AND n.link LIKE '%' || a.id::text || '%'
   );

-- 3. …a deleted PROPOSAL.
UPDATE notifications n
   SET read_at = now()
 WHERE n.read_at IS NULL
   AND n.link LIKE '/commercial/%/proposal/%'
   AND EXISTS (
     SELECT 1 FROM commercial_proposals p
      WHERE p.deleted_at IS NOT NULL
        AND n.link LIKE '%' || p.id::text || '%'
   );

-- 4. …an opportunity whose ACCOUNT is gone, even though the opp row itself is
--    still live. That is the orphan shape the account cascade produced before
--    it was fixed on 2026-08-10, and it is why a job can look reachable from
--    the bell and not be.
UPDATE notifications n
   SET read_at = now()
 WHERE n.read_at IS NULL
   AND n.link LIKE '/commercial/%'
   AND EXISTS (
     SELECT 1
       FROM commercial_opportunities o
       JOIN commercial_accounts a ON a.id = o.account_id
      WHERE a.deleted_at IS NOT NULL
        AND n.link LIKE '%' || o.id::text || '%'
   );
