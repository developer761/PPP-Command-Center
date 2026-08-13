import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isCrewOnlyUser } from "@/lib/commercial/crew-access";

export const dynamic = "force-dynamic";

/**
 * Crew home — the landing page for a scoped self-service login (Karan 2026-08).
 *
 * A crew member sees their own work and nothing else. This page is deliberately
 * four links rather than a dashboard: someone standing on a job site with one
 * bar of signal wants "where am I today / clock in", not KPIs. It's also the
 * redirect target for the allowlist gate in the Commercial layout, so it must
 * stay cheap and never itself redirect (that would loop).
 *
 * Not crew-only? Then this is just a normal page you can visit — an admin
 * checking what their crew sees. No gate here beyond Commercial access; the
 * layout owns the restriction.
 */
export default async function CrewHomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id, { allowCrew: true });

  const [profile, crewOnly] = await Promise.all([
    getProfileByUserId(user.id),
    isCrewOnlyUser(user.id),
  ]);
  const firstName =
    (profile?.sf_user_name ?? user.email ?? "").split(/[\s@]/)[0] || "there";

  // These point at the SCOPED /commercial/crew/* views, not the company-wide
  // field-ops pages. Those are admin-only and would have bounced the crew
  // member straight back with no message — three dead tiles out of four.
  const tiles: { href: string; title: string; body: string }[] = [
    {
      // First, deliberately. It is the only tile that asks something OF the
      // crew member, and it has to be done today — the others can wait.
      href: "/commercial/crew/log",
      title: "Today's hours",
      body: "Confirm what you worked. Takes a few seconds.",
    },
    {
      href: "/commercial/crew/schedule",
      title: "My schedule",
      body: "Where you're working, and when.",
    },
    {
      href: "/commercial/crew/jobs",
      title: "My jobs",
      body: "What you're on over the next few months.",
    },
    {
      href: "/commercial/field-ops/clock-station",
      title: "Clock in / out",
      body: "Punch in with your PIN.",
    },
    {
      href: "/commercial/crew/hours",
      title: "My hours",
      body: "Your scheduled and worked hours.",
    },
  ];

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">
          Hi {firstName}
        </h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">
          Your schedule, your hours, and the clock.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {tiles.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="block rounded-xl border border-ppp-charcoal-200 bg-surface px-4 py-4 hover:border-cc-brand-400 hover:shadow-sm transition-all min-h-[88px] touch-manipulation"
          >
            <div className="text-[15px] font-bold text-ppp-charcoal">{t.title}</div>
            <div className="text-[12.5px] text-ppp-charcoal-500 mt-0.5">{t.body}</div>
          </Link>
        ))}
      </div>

      {!crewOnly && (
        <p className="text-[11.5px] text-ppp-charcoal-400 border-t border-ppp-charcoal-100 pt-3">
          You&rsquo;re seeing this because you opened it directly — your login
          isn&rsquo;t restricted to these four screens. This is what a Crew login
          lands on.
        </p>
      )}
    </div>
  );
}
