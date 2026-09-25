import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getEmployeeForUser } from "@/lib/commercial/crew-access";
import { getProfileByUserId } from "@/lib/auth/profile";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import type { CommercialEmployee } from "@/lib/commercial/field-ops/employees";

const ACCESS_HREF = "/commercial/settings/access";

/**
 * Shared shell for every scoped crew page.
 *
 * One place that resolves "which employee is this login", so a page can't
 * forget to. `requireCrewEmployee` returns either the employee or the JSX for
 * the not-linked state — callers render that and stop, rather than each page
 * inventing its own handling of a state that WILL happen (crew role granted,
 * employee not yet picked).
 *
 * Deliberately does NOT redirect on the null case: the layout gate would bounce
 * an unlinked crew user straight back here, so a redirect is a loop. It's an
 * empty state, not an error.
 */
export async function requireCrewEmployee(): Promise<
  { ok: true; employee: CommercialEmployee; userId: string } | { ok: false; node: React.ReactNode }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  // Crew IS the audience here — opt back in past the default-deny gate.
  await assertCommercialAccess(user.id, { allowCrew: true });

  const employee = await getEmployeeForUser(user.id);
  if (!employee) {
    /**
     * NAMING A SCREEN IS NOT THE SAME AS OFFERING IT.
     *
     * This told every reader to go to "Settings → Access" in bold text that
     * was not a link. For the crew member that is correct — Settings → Access
     * is admin-only (`requireAccessAdmin` redirects anyone else), so linking
     * it would hand them a bounce. But an admin lands here too: the crew
     * landing page says so in as many words ("your login isn't restricted to
     * these 5 screens"), and an admin testing the crew view is the single most
     * likely visitor to this state. They were told to go ask themselves, with
     * no way through.
     *
     * So the instruction is now addressed to whoever is actually reading it,
     * and it is a link exactly when that link would work.
     */
    const profile = await getProfileByUserId(user.id);
    const canFixIt =
      normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email)) === "admin";
    return {
      ok: false,
      node: (
        <CrewPage title={canFixIt ? "This one belongs to a crew login" : "Almost there"}>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-5 text-[13.5px] text-amber-900">
            {canFixIt ? (
              <>
                <p className="font-semibold">
                  Nothing is wrong — your admin login isn&rsquo;t a crew member, so
                  there&rsquo;s no schedule to show.
                </p>
                <p className="mt-1.5 leading-relaxed">
                  To set someone up: in{" "}
                  <Link href={ACCESS_HREF} className="font-semibold underline underline-offset-2">
                    Settings → Access
                  </Link>
                  , find them under <strong>Commercial users</strong>, press{" "}
                  <strong>Restrict to crew</strong>, then pick their name in the{" "}
                  <strong>Crew member</strong> box that appears on their row. Both
                  steps are needed — the role alone lands them right here.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold">Your login isn&rsquo;t linked to a crew member yet.</p>
                <p className="mt-1.5 leading-relaxed">
                  Ask an admin to connect it in <strong>Settings → Access</strong>. Once
                  they do, your schedule, hours and jobs will show up here.
                </p>
              </>
            )}
          </div>
        </CrewPage>
      ),
    };
  }
  return { ok: true, employee, userId: user.id };
}

/** Consistent page chrome for the crew views — big targets, no dense chrome. */
export function CrewPage({
  title,
  subtitle,
  back = true,
  children,
}: {
  title: string;
  subtitle?: string;
  back?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      {back && (
        <Link
          href="/commercial/crew"
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] touch-manipulation"
        >
          <span aria-hidden>←</span> Back
        </Link>
      )}
      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">
          {title}
        </h1>
        {subtitle && <p className="text-[13px] text-ppp-charcoal-500 mt-1">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/** Shared empty state — a crew member with nothing scheduled shouldn't see a
 *  blank screen and wonder whether the app is broken. */
export function CrewEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-ppp-charcoal-200 bg-surface px-4 py-8 text-center text-[13px] text-ppp-charcoal-500">
      {children}
    </div>
  );
}
