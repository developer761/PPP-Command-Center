import Link from "next/link";
import ExampleWriter from "@/components/messaging/example-writer";
import { activeTags } from "@/lib/messaging/authoring";

export const dynamic = "force-dynamic";

export default async function WriteExamplePage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const { tag } = await searchParams;
  const tags = await activeTags();

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe">
      <Link
        href="/messaging/training/coverage"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal touch-manipulation"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        What is missing
      </Link>
      <h1 className="mt-1 mb-1 text-lg font-bold text-ppp-charcoal">Write an example</h1>
      <p className="mb-4 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
        For a rule Hatch never demonstrated, there is nothing to import and
        nothing to grade — someone who knows the right answer writing it down is
        the only way it enters training. Saved as hand-written, so it always
        stays distinguishable from a real conversation.
      </p>
      <ExampleWriter tags={tags} initialTagKey={tag} />
    </main>
  );
}
