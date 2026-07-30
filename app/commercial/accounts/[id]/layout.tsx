/**
 * Account layout — adds a `@drawer` parallel slot so a project tool (Change
 * Orders / AIA / Submittals / Closeout) opened FROM the account slides in as a
 * right-hand drawer (GHL style) over the account, while a hard nav / shared
 * link / the tool index still renders the full tool page.
 *
 * The slot is transparent when idle: `@drawer/default.tsx` returns null, so the
 * account + every sub-route renders exactly as before. See the intercepting
 * routes under `@drawer/(.)<tool>/[dealId]`.
 */
export default function AccountLayout({
  children,
  drawer,
}: {
  children: React.ReactNode;
  drawer: React.ReactNode;
}) {
  return (
    <>
      {children}
      {drawer}
    </>
  );
}
