import "server-only";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Internal copies on every proposal email that reaches a GC (Karan 2026-08-04).
 * These addresses become the Reply-To (so the GC's reply reaches Brendan + the
 * ops inbox, not a generic company address) AND a silent BCC (so they always
 * have a copy of what went out). Brendan runs proposal approvals, so replies
 * should land with him. Overridable via env (comma-separated) without a deploy.
 *
 * Shared by the proposal send and the e-signature emails — a signed contract
 * the office never received a copy of is worse than the proposal itself going
 * uncopied.
 */
export const PROPOSAL_COPY_EMAILS = (
  process.env.COMMERCIAL_PROPOSAL_COPY_EMAILS ||
  "brendan@tomcopainting.com,developer@precisionpaintingplus.net"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter((e) => EMAIL_RE.test(e));
