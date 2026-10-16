import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A write that matched nothing is not a write.
 *
 * supabase-js RESOLVES on failure, and an UPDATE whose filters match zero rows
 * resolves with no error at all. Every function below read only `error` (or
 * nothing), so each one reported success for a write that did not happen:
 *
 *   - the dunning claims, whose whole job is "claim before you email", let two
 *     overlapping runs both email the same client;
 *   - a work-order delete whose shift-cancel failed said "deleted" while the
 *     crew stayed on the calendar, and the cascade counted it as torn down;
 *   - a cost-rate change whose window-close failed left two rates open;
 *   - a failed rate read priced every crew hour at $0.
 *
 * Tested against an in-memory table that APPLIES the filters, so the claim's
 * conditions are exercised for what they match, not for how they are spelled.
 */

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {};
  /** `${table}:${op}` → how many upcoming calls of that kind fail. */
  failures = new Map<string, { message: string; times: number }>();
  /** Runs just before a mutation is applied — simulates the other tab. */
  beforeMutate: ((table: string, op: string) => void) | null = null;
  calls: { table: string; op: string }[] = [];
  from(table: string) {
    this.tables[table] ??= [];
    return new FakeQuery(this, table);
  }
  fail(table: string, op: string, message = "boom", times = 1) {
    this.failures.set(`${table}:${op}`, { message, times });
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private op: "select" | "update" | "delete" | "insert" = "select";
  private patch: Row = {};
  private inserts: Row[] = [];
  private filters: ((r: Row) => boolean)[] = [];
  private returning = false;
  private mode: "many" | "maybe" | "single" = "many";
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select() {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.patch = p;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  insert(r: Row | Row[]) {
    this.op = "insert";
    this.inserts = Array.isArray(r) ? r : [r];
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  is(c: string, v: null) {
    this.filters.push((r) => (v === null ? r[c] == null : r[c] === v));
    return this;
  }
  not(c: string, op: string, v: unknown) {
    if (op === "is") this.filters.push((r) => r[c] != null);
    else if (op === "in") {
      const set = String(v).replace(/[()]/g, "").split(",");
      this.filters.push((r) => !set.includes(String(r[c])));
    } else throw new Error(`fake: not.${op}`);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  gt(c: string, v: number | string) {
    this.filters.push((r) => (r[c] as number | string) > v);
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => String(r[c]) >= v);
    return this;
  }
  lte(c: string, v: string) {
    this.filters.push((r) => String(r[c]) <= v);
    return this;
  }
  or(expr: string) {
    const parts = expr.split(",").map((p) => {
      const [col, op, ...rest] = p.split(".");
      const val = rest.join(".");
      if (op === "is" && val === "null") return (r: Row) => r[col] == null;
      if (op === "lt") return (r: Row) => r[col] != null && String(r[col]) < val;
      throw new Error(`fake: or ${p}`);
    });
    this.filters.push((r) => parts.some((f) => f(r)));
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  then<A, B>(
    ok?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.exec()).then(ok, bad);
  }
  private exec(): { data: unknown; error: { message: string } | null } {
    this.db.calls.push({ table: this.table, op: this.op });
    const key = `${this.table}:${this.op}`;
    const f = this.db.failures.get(key);
    if (f && f.times > 0) {
      f.times -= 1;
      return { data: null, error: { message: f.message } };
    }
    if (this.op !== "select") this.db.beforeMutate?.(this.table, this.op);
    const rows = this.db.tables[this.table];
    if (this.op === "insert") {
      const made = this.inserts.map((r, i) => ({ id: `new-${rows.length + i}`, ...r }));
      rows.push(...made);
      return this.shape(made);
    }
    const hit = rows.filter((r) => this.filters.every((fn) => fn(r)));
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.patch);
      return this.returning ? this.shape(hit.map((r) => ({ ...r }))) : { data: null, error: null };
    }
    if (this.op === "delete") {
      this.db.tables[this.table] = rows.filter((r) => !hit.includes(r));
      return this.returning ? this.shape(hit) : { data: null, error: null };
    }
    return this.shape(hit.map((r) => ({ ...r })));
  }
  private shape(arr: Row[]) {
    if (this.mode === "many") return { data: arr, error: null };
    if (this.mode === "single" && arr.length !== 1) return { data: null, error: { message: "not exactly one row" } };
    return { data: arr[0] ?? null, error: null };
  }
}

let db = new FakeDb();
const logDelete = vi.fn();
const logUpdate = vi.fn();
const logInsert = vi.fn();
const resync = vi.fn();

vi.mock("@/lib/commercial/db", () => ({ commercialDb: () => db }));
vi.mock("@/lib/commercial/audit-log", () => ({
  logDelete: (...a: unknown[]) => logDelete(...a),
  logUpdate: (...a: unknown[]) => logUpdate(...a),
  logInsert: (...a: unknown[]) => logInsert(...a),
}));
vi.mock("@/lib/commercial/field-ops/schedule-email-send", () => ({
  resyncClockReminder: (...a: unknown[]) => resync(...a),
}));

const FUTURE = "2999-01-01";

beforeEach(() => {
  db = new FakeDb();
  // The real ones return promises, and callers chain `.catch` on them.
  for (const m of [logDelete, logUpdate, logInsert]) {
    m.mockReset();
    m.mockResolvedValue(undefined);
  }
  resync.mockReset();
  resync.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the dunning claim is conditional, so only one run emails", () => {
  const cutoff = "2026-10-09T00:00:00.000Z";
  const overdue = () => ({
    id: "inv1",
    status: "sent",
    balance_cents: 5000,
    deleted_at: null,
    last_dunning_at: null,
  });

  it("claims a qualifying invoice and stamps it", async () => {
    const { claimInvoiceForDunning } = await import("@/lib/commercial/cron/invoice-dunning");
    db.tables.commercial_invoices = [overdue()];
    const r = await claimInvoiceForDunning(db as never, "inv1", cutoff);
    expect(r).toEqual({ claimed: true });
    expect(db.tables.commercial_invoices[0].last_dunning_at).not.toBeNull();
  });

  it("a second, overlapping run does NOT get the same invoice", async () => {
    const { claimInvoiceForDunning } = await import("@/lib/commercial/cron/invoice-dunning");
    db.tables.commercial_invoices = [overdue()];
    await claimInvoiceForDunning(db as never, "inv1", cutoff);
    expect(await claimInvoiceForDunning(db as never, "inv1", cutoff)).toEqual({ claimed: false });
  });

  it("an invoice paid, voided or deleted since the read is not claimed", async () => {
    const { claimInvoiceForDunning } = await import("@/lib/commercial/cron/invoice-dunning");
    for (const change of [{ status: "paid" }, { status: "void" }, { deleted_at: "2026-10-16" }, { balance_cents: 0 }]) {
      db.tables.commercial_invoices = [{ ...overdue(), ...change }];
      expect(await claimInvoiceForDunning(db as never, "inv1", cutoff)).toEqual({ claimed: false });
    }
  });

  it("a failed write is an error, not a claim", async () => {
    const { claimInvoiceForDunning } = await import("@/lib/commercial/cron/invoice-dunning");
    db.tables.commercial_invoices = [overdue()];
    db.fail("commercial_invoices", "update", "timeout");
    expect(await claimInvoiceForDunning(db as never, "inv1", cutoff)).toEqual({ claimed: false, error: "timeout" });
  });

  it("an AIA application whose marker moved since the read is not claimed", async () => {
    const { claimAiaForDunning } = await import("@/lib/commercial/cron/aia-dunning");
    db.tables.commercial_aia_applications = [
      { id: "a1", status: "submitted", deleted_at: null, last_dunning_at: "2026-10-16T09:00:00Z" },
    ];
    // This run read `null`; another run has stamped it since.
    expect(await claimAiaForDunning(db as never, "a1", null)).toEqual({ claimed: false });
    expect(await claimAiaForDunning(db as never, "a1", "2026-10-16T09:00:00Z")).toEqual({ claimed: true });
  });
});

describe("tearing down a Field Ops job reports what actually happened", () => {
  const seed = () => {
    db.tables.commercial_jobs = [
      { id: "j1", opportunity_id: "o1", work_order_id: "wo1", deleted_at: null },
      { id: "j2", opportunity_id: "o1", work_order_id: null, deleted_at: null },
    ];
    db.tables.commercial_assignments = [
      { id: "s1", job_id: "j1", employee_id: "e1", work_date: FUTURE, status: "scheduled" },
      { id: "s2", job_id: "j2", employee_id: "e2", work_date: FUTURE, status: "scheduled" },
    ];
    db.tables.commercial_work_orders = [{ id: "wo1", status: "sent" }];
  };

  it("a delete that lost the race to another tab is not a delete", async () => {
    const { softDeleteJob } = await import("@/lib/commercial/field-ops/jobs");
    seed();
    db.beforeMutate = (t) => {
      if (t === "commercial_jobs") db.tables.commercial_jobs[0].deleted_at = "2026-10-16";
    };
    const r = await softDeleteJob("j1", "u1");
    expect(r.ok).toBe(false);
    expect(logDelete).not.toHaveBeenCalled();
    expect(db.tables.commercial_assignments[0].status).toBe("scheduled");
  });

  it("a failed shift-cancel is reported, and the rest of the teardown still runs", async () => {
    const { softDeleteJob } = await import("@/lib/commercial/field-ops/jobs");
    seed();
    db.fail("commercial_assignments", "update");
    const r = await softDeleteJob("j1", "u1");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/still on the calendar/);
    // The WO was still reopened, so the backfill cannot resurrect the job.
    expect(db.tables.commercial_work_orders[0].status).toBe("draft");
    expect(db.tables.commercial_jobs[0].deleted_at).not.toBeNull();
  });

  it("a clean teardown cancels the shifts and says ok", async () => {
    const { softDeleteJob } = await import("@/lib/commercial/field-ops/jobs");
    seed();
    expect(await softDeleteJob("j1", "u1")).toEqual({ ok: true });
    expect(db.tables.commercial_assignments[0].status).toBe("cancelled");
  });

  it("the deal cascade counts only the jobs that were really torn down", async () => {
    const { cascadeDeleteJobsForOwner } = await import("@/lib/commercial/field-ops/jobs");
    seed();
    db.fail("commercial_assignments", "update", "boom", 1);
    expect(await cascadeDeleteJobsForOwner({ opportunity_id: "o1" }, "u1")).toBe(1);
  });

  it("the restore counts and revives only what it matched", async () => {
    const { cascadeRestoreJobsForOwner } = await import("@/lib/commercial/field-ops/jobs");
    const at = "2026-10-16T12:00:00.000Z";
    db.tables.commercial_jobs = [{ id: "j1", opportunity_id: "o1", deleted_at: at }];
    db.tables.commercial_assignments = [
      { id: "s1", job_id: "j1", employee_id: "e1", work_date: FUTURE, status: "cancelled" },
    ];
    db.fail("commercial_jobs", "update");
    expect(await cascadeRestoreJobsForOwner({ opportunity_id: "o1" }, at, "u1")).toBe(0);
    // Nothing came back, so the crew must not have been put back either.
    expect(db.tables.commercial_assignments[0].status).toBe("cancelled");
    expect(await cascadeRestoreJobsForOwner({ opportunity_id: "o1" }, at, "u1")).toBe(1);
    expect(db.tables.commercial_assignments[0].status).toBe("scheduled");
  });
});

describe("cost rates", () => {
  it("a failed window-close stops the new rate, so two never stand open", async () => {
    const { setCostRate } = await import("@/lib/commercial/field-ops/rates");
    db.tables.commercial_employee_rates = [
      { id: "r1", employee_id: "e1", cost_rate_cents: 3000, effective_from: "2026-01-01", effective_to: null },
    ];
    db.fail("commercial_employee_rates", "update");
    const r = await setCostRate("e1", 3500, "u1");
    expect(r.ok).toBe(false);
    expect(db.tables.commercial_employee_rates).toHaveLength(1);
  });

  it("a failed rate read throws instead of pricing every hour at $0", async () => {
    const { loadRates } = await import("@/lib/commercial/field-ops/labor-cost");
    db.fail("commercial_employee_rates", "select");
    await expect(loadRates(["e1"])).rejects.toThrow(/cost rates/);
  });
});

describe("stamps after a send", () => {
  it("the crew-emailed stamp reports a zero-row write as not stamped", async () => {
    const { markWorkOrderEmailed } = await import("@/lib/commercial/work-orders/db");
    db.tables.commercial_work_orders = [{ id: "wo1" }];
    expect(await markWorkOrderEmailed("wo-gone")).toBe(false);
    expect(await markWorkOrderEmailed("wo1")).toBe(true);
  });
});

describe("deleting a draft close-out package", () => {
  it("does not log a delete when the package was issued in between", async () => {
    const { deleteCloseoutPackage } = await import("@/lib/commercial/closeout/db");
    db.tables.commercial_closeout_packages = [{ id: "p1", status: "draft", voided_at: null }];
    db.beforeMutate = (t) => {
      if (t === "commercial_closeout_packages") db.tables.commercial_closeout_packages[0].status = "sent";
    };
    const r = await deleteCloseoutPackage("p1", "u1");
    expect(r.ok).toBe(false);
    expect(logDelete).not.toHaveBeenCalled();
  });
});
