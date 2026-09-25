import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { ROLES, roleFor } from "@/lib/commercial/guide/roles";
import { roleTour, type RoleGuide } from "@/lib/commercial/guide/walkthrough";
import { getSampleJob, resolveJobHref } from "@/lib/commercial/guide/sample-job";
import { SurfaceCard } from "@/components/commercial/guide-surface";
import { TourButton } from "@/components/commercial/guide-tour-button";

/**
 * `/commercial/guide` — "How it works", the walkthrough, on screen.
 *
 * Karan 2026-09-16: "make this a tab instead of just a PDF… they can go as
 * Brendan / Stephanie / Mary and it gives them their tabs and what they do and
 * what each button does, and an overview one that goes through everything a bit
 * less detailed."
 *
 * The role is a QUERY PARAM, not a setting: people read each other's chapters.
 * Mary wants to know what Stephanie does with a change order before she bills
 * it, and a new starter reads all four. Storing it as a preference would make
 * that a trip to Settings.
 *
 * Content lives in `lib/commercial/guide/roles.ts`; the PDF handbook is built
 * from the same place, so the printed copy and the screen cannot drift.
 */

export const metadata = { title: "How it works" };

export const dynamic = "force-dynamic";

type SP = Promise<{ as?: string }>;

/** Swap `:job` / `:wonjob` for a real id, dropping what cannot be resolved. */
function withRealJob(role: RoleGuide, sample: Awaited<ReturnType<typeof getSampleJob>>): RoleGuide {
  return {
    ...role,
    chapters: role.chapters
      .map((c) => ({
        ...c,
        surfaces: c.surfaces.flatMap((su) => {
          const href = resolveJobHref(su.href, sample);
          return href ? [{ ...su, href }] : [];
        }),
      }))
      .filter((c) => c.surfaces.length > 0),
  };
}

export default async function GuidePage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const sp = await searchParams;
  /**
   * Job-scoped surfaces carry a `:job` placeholder, resolved here against a real
   * job so "Try it out" opens an actual Proposals tab rather than the list of
   * every job — which is what the first version did, on nine surfaces, while
   * the card said "The job › Proposals".
   *
   * A surface whose placeholder cannot be filled (no won job on the book yet)
   * is dropped rather than shown with a dead link.
   */
  const sample = await getSampleJob();
  const role = withRealJob(roleFor(sp.as), sample);
  const tourLength = roleTour(role).length;

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 py-6 space-y-5">
      <header>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">
          How it works
        </h1>
        <p className="text-[12.5px] text-ppp-charcoal-500 mt-1.5 max-w-2xl leading-relaxed">
          Pick whose day you want to walk through. Each one covers only the pages that person uses, what they are for,
          and what every button on them does.
        </p>
      </header>

      {/* ── Who are you ── */}
      <nav aria-label="Choose a role" className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {ROLES.map((r) => {
          const active = r.key === role.key;
          return (
            <Link
              key={r.key}
              href={r.key === "overview" ? "/commercial/guide" : `/commercial/guide?as=${r.key}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-xl border p-3 min-h-[44px] transition-colors ${
                active
                  ? "border-cc-brand-600 bg-cc-brand-50"
                  : "border-ppp-charcoal-100 bg-surface hover:border-cc-brand-300 hover:bg-ppp-charcoal-50"
              }`}
            >
              <span
                className={`block text-[14px] font-bold ${active ? "text-cc-brand-900" : "text-ppp-charcoal"}`}
              >
                {r.label}
              </span>
              <span
                className={`block text-[11.5px] mt-0.5 leading-snug ${
                  active ? "text-cc-brand-800" : "text-ppp-charcoal-500"
                }`}
              >
                {r.tagline}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* ── The whole thing, start to finish ──
          One button that walks every surface in this role's list, in the order
          they meet them on a normal day. The per-surface buttons below are for
          somebody who already knows what they are looking for; this is for the
          first morning, where the useful thing is the ORDER. */}
      <div className="rounded-xl border border-cc-brand-300 bg-cc-brand-50 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-[13px] text-cc-brand-900 leading-relaxed">{role.intro}</p>
          <p className="text-[11.5px] text-cc-brand-800 mt-1.5">
            {role.key === "overview"
              ? `${tourLength} stops around the platform.`
              : `${tourLength} stops through ${role.label}'s day, in order.`}{" "}
            Nothing can be changed while it runs.
          </p>
        </div>
        <TourButton steps={roleTour(role)} label={role.key === "overview" ? "The platform" : `${role.label}'s day`} variant="primary">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 3l14 9-14 9z" />
          </svg>
          {role.key === "overview" ? "Walk me round the platform" : `Walk me through ${role.label}'s day`}
        </TourButton>
      </div>

      {/* ── The walkthrough ── */}
      {role.chapters.map((c) => (
        <section key={c.id} id={c.id} className="space-y-3 scroll-mt-4">
          <div className="border-t border-ppp-charcoal-100 pt-4">
            <h2 className="text-[17px] font-bold text-ppp-charcoal flex items-center gap-2">
              <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
              {c.title}
            </h2>
            <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 leading-relaxed">{c.blurb}</p>
          </div>
          {c.surfaces.map((su) => (
            <SurfaceCard key={su.name + su.href} surface={su} />
          ))}
        </section>
      ))}

      {/* ── The printed copy ── */}
      <footer className="border-t border-ppp-charcoal-100 pt-4 flex flex-wrap items-center gap-3 justify-between">
        <p className="text-[12px] text-ppp-charcoal-500 max-w-md leading-relaxed">
          Want it on paper? The same walkthrough prints as a branded handbook — good for a desk drawer or a first
          morning.
        </p>
        <a
          href="/api/commercial/guide/pdf"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface px-3 min-h-[40px] text-[12.5px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50 hover:border-cc-brand-300"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z" />
          </svg>
          Print the handbook
        </a>
      </footer>
    </div>
  );
}
