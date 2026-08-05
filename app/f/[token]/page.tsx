import { getEmployeeByToken, getEmployeeDay } from "@/lib/commercial/field-ops/clock";
import { todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { PainterClock } from "@/components/commercial/painter-clock";

export const dynamic = "force-dynamic";
export const metadata = { title: "My schedule", robots: { index: false } };

/**
 * R10.3 - the painter's personal magic-link page (public, no login). The URL
 * token identifies them; they see today's jobs and clock in/out. Lives at
 * /f/[token], outside the authed /commercial shell.
 */
export default async function PainterPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const employee = await getEmployeeByToken(token);

  if (!employee) {
    return (
      <main className="min-h-screen bg-ppp-charcoal-50/40 flex items-center justify-center p-6">
        <div className="text-center max-w-sm space-y-3">
          <div>
            <div className="text-lg font-bold text-ppp-charcoal">This link isn&rsquo;t valid</div>
            <p className="text-[13px] text-ppp-charcoal-500 mt-1">Ask the office to resend your schedule link, or clock in on the shop tablet.</p>
          </div>
          <div className="border-t border-ppp-charcoal-100 pt-3">
            <div className="text-lg font-bold text-ppp-charcoal">Este enlace no funciona</div>
            <p className="text-[13px] text-ppp-charcoal-500 mt-1">Pide a la oficina que te reenvíe tu enlace, o marca entrada en la tableta del taller.</p>
          </div>
        </div>
      </main>
    );
  }

  const es = employee.preferred_language === "es";
  const today = todayEtIso();
  const day = await getEmployeeDay(employee.id, today);
  const dateLabel = new Date(today + "T12:00:00Z").toLocaleDateString(es ? "es-US" : "en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="min-h-screen bg-ppp-charcoal-50/40 py-6 px-4">
      <div className="max-w-md mx-auto">
        <PainterClock token={token} firstName={employee.first_name} day={day} dateLabel={dateLabel} es={es} />
      </div>
    </main>
  );
}
