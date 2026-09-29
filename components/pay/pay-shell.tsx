import Image from "next/image";
import { PPP_BRAND } from "@/lib/brand";

/**
 * Branded frame for the customer payment pages (/pay/<token>…). Same header,
 * width and footer as the color-selection page so a customer who has seen one
 * recognises the other.
 */
export function PayShell({
  children,
  previewNote,
}: {
  children: React.ReactNode;
  /** Shown as a strip above everything while the pages are admin-only. */
  previewNote?: string | null;
}) {
  return (
    <div className="min-h-screen bg-[var(--color-surface-muted)] flex flex-col">
      {previewNote && (
        <div className="bg-ppp-orange-50 border-b border-ppp-orange-100 text-ppp-orange-700 text-[12px] sm:text-[13px] px-4 py-2 text-center">
          {previewNote}
        </div>
      )}
      <header className="bg-white border-b border-ppp-charcoal-100">
        <div className="max-w-xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <Image src="/brand/logo.svg" alt={PPP_BRAND.name} width={180} height={60} priority className="h-9 sm:h-10 w-auto" />
          <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-charcoal-500">
            Invoice Payment
          </div>
        </div>
      </header>
      <main className="flex-1 w-full max-w-xl mx-auto px-4 sm:px-6 py-6 sm:py-10">{children}</main>
      <footer className="px-4 sm:px-6 py-6 text-center text-[11px] text-ppp-charcoal-500">
        {PPP_BRAND.name} · {PPP_BRAND.tagline}
      </footer>
    </div>
  );
}

export function PayMessage({ tone, heading, body }: { tone: "warn" | "ok"; heading: string; body: React.ReactNode }) {
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-8 sm:p-10 text-center">
      <div
        className={`mx-auto h-14 w-14 rounded-full flex items-center justify-center text-2xl mb-4 ${
          tone === "ok" ? "bg-ppp-green-50 text-ppp-green-700" : "bg-ppp-orange-50 text-ppp-orange-700"
        }`}
        aria-hidden
      >
        {tone === "ok" ? "✓" : "⚠"}
      </div>
      <h1 className="text-xl sm:text-2xl font-bold text-ppp-navy">{heading}</h1>
      <div className="mt-3 text-sm sm:text-base text-ppp-charcoal-600 max-w-md mx-auto">{body}</div>
    </div>
  );
}
