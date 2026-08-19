import "server-only";

/**
 * Is this a PPP-owned mailbox?
 *
 * Used to decide whether the person placing an order is safe to expose to a
 * vendor — CC'd on the send and printed in the email's questions block. A
 * contractor or admin signed in with a personal Gmail must be neither: the
 * address would sit in a vendor's headers and reply history permanently.
 *
 * Env-driven so PPP can add a domain without a deploy.
 */
export function companyEmailDomains(): string[] {
  return (process.env.COMPANY_EMAIL_DOMAINS ?? "precisionpaintingplus.com,precisionpaintingplus.net")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function isCompanyEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return false;
  return companyEmailDomains().some((d) => e.endsWith(`@${d}`));
}
