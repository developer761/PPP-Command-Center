import { NextResponse } from "next/server";
import { getEmployeeByToken, clockIn, clockOut, getEmployeeDay } from "@/lib/commercial/field-ops/clock";
import { todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { getCommercialSetting } from "@/lib/commercial/settings";
import { CLOCK_OVERRIDE_PIN_KEY, DEFAULT_CLOCK_OVERRIDE_PIN, CLOCK_WINDOW_MINUTES } from "@/lib/commercial/field-ops/clock-window";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current time as ET minutes-since-midnight — the job is TODAY, so comparing
 *  minutes-of-day sidesteps all EST/EDT offset math. */
function nowEtMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/** "HH:MM" for a minutes-since-midnight value. */
function hhmm(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * POST /api/f/clock - PUBLIC, painter magic-link clock in/out. The token IS the
 * auth: it resolves to the employee, who can only clock themselves. Body:
 *   { token, action: "in" | "out", job_id?, assignment_id? }
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const action = String(body.action ?? "");

  const employee = await getEmployeeByToken(token);
  if (!employee) return NextResponse.json({ error: "invalid_token" }, { status: 401 });

  if (action === "out") {
    const result = await clockOut({ employee_id: employee.id, source: "self_link" });
    if (!result.ok) return NextResponse.json({ error: "clock_failed", code: result.code, detail: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (action === "in") {
    const job_id = String(body.job_id ?? "");
    const assignment_id = body.assignment_id ? String(body.assignment_id) : null;
    if (!UUID_RE.test(job_id)) return NextResponse.json({ error: "invalid_job" }, { status: 400 });

    // 10-minute clock-in window — enforced HERE (the client's lock is only UX).
    // Look up TODAY's assignment for its scheduled start; if we're more than the
    // window early, block unless the correct admin override PIN was supplied.
    const today = todayEtIso();
    const day = await getEmployeeDay(employee.id, today);
    const assign =
      day.assignments.find((a) => assignment_id && a.assignment_id === assignment_id) ??
      day.assignments.find((a) => a.job_id === job_id);
    const startTime = assign?.scheduled_start_time ?? null;
    if (startTime) {
      const [sh, sm] = startTime.split(":").map(Number);
      const opensAt = sh * 60 + (sm || 0) - CLOCK_WINDOW_MINUTES;
      if (nowEtMinutes() < opensAt) {
        const overridePin = String(body.override_pin ?? "").trim();
        const setPin = await getCommercialSetting<string>(CLOCK_OVERRIDE_PIN_KEY, DEFAULT_CLOCK_OVERRIDE_PIN);
        const overridden = overridePin.length > 0 && overridePin === setPin;
        if (!overridden) {
          return NextResponse.json(
            { ok: false, error: "too_early", code: "too_early", detail: hhmm(opensAt) },
            { status: 400 }
          );
        }
      }
    }

    const result = await clockIn({
      employee_id: employee.id,
      job_id,
      assignment_id: assignment_id && UUID_RE.test(assignment_id) ? assignment_id : null,
      source: "self_link",
    });
    if (!result.ok) return NextResponse.json({ error: "clock_failed", code: result.code, detail: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
