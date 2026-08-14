/**
 * Resolve a `/dashboard/materials/[woId]` route param to a real work order.
 *
 * Salesforce hands out both 15-char (Classic) and 18-char Ids for the same
 * record, and the SF "Open in Command Center" button, the mail links and global
 * search don't agree on which one they use — so the match has to tolerate one
 * being a prefix of the other (Kate round-1 #8).
 *
 * Prefix matching is deliberately gated on a real SF Id length. Every PPP work
 * order Id starts "0WO", so an accidental `/materials/0` would otherwise
 * prefix-match the first WO in the list and confidently render somebody else's
 * job.
 *
 * Shared by the client view and the order pages so the two can't drift apart.
 */
export function resolveWorkOrderId<T extends { wo: { id: string } }>(
  rawId: string | null | undefined,
  jobs: ReadonlyArray<T>
): string | null {
  if (!rawId) return null;
  const target = rawId.trim();
  if (!target) return null;
  const canPrefix = target.length === 15 || target.length === 18;
  const hit = jobs.find((j) => {
    if (j.wo.id === target) return true;
    if (!canPrefix) return false;
    return j.wo.id.startsWith(target) || target.startsWith(j.wo.id);
  });
  return hit?.wo.id ?? null;
}
