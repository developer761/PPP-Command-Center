import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getEmployeeForUser } from "@/lib/commercial/crew-access";
import type { CommercialEmployee } from "@/lib/commercial/field-ops/employees";

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
  await assertCommercialAccess(user.id);

  const employee = await getEmployeeForUser(user.id);
  if (!employee) {
    return {
      ok: false,
      node: (
        <CrewPage title="Almost there">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-5 text-[13.5px] text-amber-900">
            <p className="font-semibold">Your login isn&rsquo;t linked to a crew member yet.</p>
            <p className="mt-1.5 leading-relaxed">
              Ask an admin to connect it in <strong>Settings → Access</strong>. Once
              they do, your schedule, hours and jobs will show up here.
            </p>
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
