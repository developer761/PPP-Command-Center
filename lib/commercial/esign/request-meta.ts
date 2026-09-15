import "server-only";

/**
 * Who is on the other end of a request — IP address and browser — for the
 * audit trail.
 *
 * Vercel sets `x-forwarded-for` with the client first; `x-real-ip` is the
 * fallback some proxies use. Both are trimmed and capped: this is written
 * straight onto a legal record, and a header is attacker-controlled text.
 */
export function clientMeta(h: Headers): { ip: string | null; userAgent: string | null } {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (forwarded || h.get("x-real-ip")?.trim() || "").slice(0, 64) || null;
  const userAgent = (h.get("user-agent") ?? "").trim().slice(0, 512) || null;
  return { ip, userAgent };
}
