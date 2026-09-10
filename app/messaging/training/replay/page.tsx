import Link from "next/link";
import ScenarioReplay from "@/components/messaging/scenario-replay";
import { savedScenarios } from "@/lib/messaging/replay-run";

export const dynamic = "force-dynamic";

export default async function ReplayPage() {
  const scenarios = await savedScenarios();

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <Link href="/messaging/training"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 touch-manipulation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Training
      </Link>

      <header>
        <h1 className="text-lg font-bold text-ppp-charcoal">What changed</h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          Run the conversations you have already judged against the bot as it is
          now. Changing Emily&apos;s rules should tell you what broke, rather than a
          customer telling you.
        </p>
      </header>

      <ScenarioReplay scenarios={scenarios} />

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <p className="text-[12px] text-ppp-charcoal-500 leading-relaxed">
          A replay sends the same customer messages again and builds its own
          history as it goes, because what the bot says at turn four depends on
          turns one to three. So one changed answer early can legitimately
          change everything after it — that is a real result, not noise.
          Rewording is never counted as a regression: a change that says the
          same thing differently would otherwise light up every test and teach
          everybody to ignore it.
        </p>
      </section>
    </main>
  );
}
