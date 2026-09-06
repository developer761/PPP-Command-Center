import Link from "next/link";
import TrainingImportForm from "@/components/messaging/training-import-form";

export const dynamic = "force-dynamic";

export default function TrainingImportPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe">
      <Link
        href="/messaging/training"
        className="inline-flex items-center gap-1.5 min-h-[44px] -ml-1 px-1 text-[13px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal touch-manipulation"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Training
      </Link>
      <h1 className="mt-1 mb-1 text-lg font-bold text-ppp-charcoal">Import conversations</h1>
      <p className="mb-4 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
        Personal details are removed in your browser before anything is sent.
        You see exactly what each row becomes first.
      </p>
      <TrainingImportForm />
    </main>
  );
}
