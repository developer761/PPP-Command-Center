import { NextResponse } from "next/server";
import { getEmployeeByToken, clockIn, clockOut } from "@/lib/commercial/field-ops/clock";
import { UUID_RE } from "@/lib/commercial/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    if (!result.ok) return NextResponse.json({ error: "clock_failed", detail: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (action === "in") {
    const job_id = String(body.job_id ?? "");
    const assignment_id = body.assignment_id ? String(body.assignment_id) : null;
    if (!UUID_RE.test(job_id)) return NextResponse.json({ error: "invalid_job" }, { status: 400 });
    const result = await clockIn({
      employee_id: employee.id,
      job_id,
      assignment_id: assignment_id && UUID_RE.test(assignment_id) ? assignment_id : null,
      source: "self_link",
    });
    if (!result.ok) return NextResponse.json({ error: "clock_failed", detail: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
