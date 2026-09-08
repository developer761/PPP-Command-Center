import Link from "next/link";
import OptOutImportForm from "@/components/messaging/optout-import-form";
import { suppressionCount } from "@/lib/messaging/optout-import-write";

export const dynamic = "force-dynamic";

export default async function OptOutsPage() {
  const counts = await suppressionCount();
  const empty = counts.sms === 0 && counts.email === 0;

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <Link href="/messaging/settings"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 touch-manipulation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Settings
      </Link>

      <header>
        <h1 className="font-bold text-ppp-charcoal">Who we must not text</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Everyone who told Hatch to stop. The gate checks this before every
          single send, ahead of every other rule, and nothing overrides it.
        </p>
      </header>

      <section className={[
        "rounded-xl border px-4 py-3",
        empty ? "border-ppp-orange-100 bg-ppp-orange-50" : "border-ppp-charcoal-100 bg-white",
      ].join(" ")}>
        {empty ? (
          <>
            <p className="text-[13px] font-semibold text-ppp-orange-700">Nothing is suppressed yet</p>
            <p className="mt-1 text-[12.5px] text-ppp-orange-700/90 leading-relaxed">
              Until Hatch&apos;s list is loaded, every person who has already asked
              PPP to stop looks like a fresh lead to this system. This has to be
              done before the first real message, not after.
            </p>
          </>
        ) : (
          <p className="text-[13px] text-ppp-charcoal">
            <strong className="tabular-nums">{counts.sms}</strong> numbers and{" "}
            <strong className="tabular-nums">{counts.email}</strong> email addresses suppressed.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">
          Import from Hatch
        </h2>
        <div className="px-4 py-3">
          <OptOutImportForm />
        </div>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">Why Hatch and not Salesforce</h2>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Kate&apos;s own numbers: of 213 opt-out notifications Salesforce could not
          match, 98 had no Salesforce record at all and 55 matched a record that
          was still not marked opted out. Salesforce sits downstream of a
          matching step that drops a quarter of them. Hatch is where the person
          actually said stop, so Hatch is what we trust. 92 of those 213 came in
          over email, which is why this reads both columns.
        </p>
      </section>
    </main>
  );
}
