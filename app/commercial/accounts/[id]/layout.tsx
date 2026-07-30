/**
 * Account layout.
 *
 * The delivery tools (Change Orders / AIA / Submittals / Closeout) now render
 * INLINE under the deal's Project sub-tab (deal view → Project), so the old
 * right-hand `@drawer` parallel slot was retired (2026-08). This layout is a
 * plain pass-through; the standalone tool routes still render full pages for
 * direct hits / bookmarks.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
