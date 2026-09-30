/**
 * Loading the standing answers, and what happens when that read fails.
 *
 * This loader sits on the per-turn hot path, which makes its failure mode a
 * question about the customer's reply and not about the knowledge base.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaceFaqs, loadSharedFaqs, clearWorkspaceFaqCache } from "@/lib/messaging/workspace-faq-db";

/** A client whose range() answers however the test says, counting its reads. */
function stub(answer: () => { data: unknown[] | null; error: { message: string } | null }) {
  const calls = { reads: 0, filters: [] as string[] };
  const api: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "order", "is"]) api[m] = () => api;
  // `or` is here because the loader reads BOTH tiers — the workspace's own
  // rows and the shared ones (workspace_id IS NULL). A stub without it throws
  // rather than quietly returning a workspace-only set, which is the point.
  api.or = (filter: string) => { calls.filters.push(filter); return api; };
  api.range = async () => { calls.reads++; return answer(); };
  return { sb: api as unknown as SupabaseClient, calls };
}

const rows = [
  { question: "Are you insured?", answer: "Yes, we are fully licensed and insured." },
  { question: "how much", answer: "About $2,500." },
];

/**
 * A REAL UUID, because the loader now refuses anything that is not one.
 * `workspaceId` goes into a PostgREST `.or()` FILTER STRING, where a comma
 * starts another condition — so its shape is a correctness property, not a
 * formality. See the guard in workspace-faq-db.ts.
 */
const W1 = "11111111-2222-3333-4444-555555555555";

beforeEach(() => clearWorkspaceFaqCache());
afterEach(() => vi.restoreAllMocks());

describe("reading them", () => {
  it("returns the active rows, and drops an unsafe one on the way out", () => {
    // The check runs at READ time as well as at save time: the table is what a
    // person edits, so a save-time check is advice until something enforces it
    // on the way to the prompt.
    const { sb } = stub(() => ({ data: rows, error: null }));
    return loadWorkspaceFaqs(sb, W1).then((out) => {
      expect(out.map((f) => f.question)).toEqual(["Are you insured?"]);
    });
  });

  it("reads once per workspace, then serves the cache", async () => {
    const { sb, calls } = stub(() => ({ data: [rows[0]], error: null }));
    await loadWorkspaceFaqs(sb, W1);
    await loadWorkspaceFaqs(sb, W1);
    expect(calls.reads).toBe(1);
  });
});

/**
 * ── THE SHARED TIER ─────────────────────────────────────────────────────
 *
 * `workspace_id IS NULL` means "every workspace". The whole feature is one
 * `.or` in the query and one precedence rule after it, and BOTH are the kind
 * of thing that fails silently: a missing `.or` gives a shared row that is
 * saved, listed, and never used; a missing precedence rule gives the model
 * two answers to one question and no way for anyone to know which it took.
 */
describe("shared answers", () => {
  const shared = (q: string, a: string) => ({ question: q, answer: a, workspace_id: null });
  const local = (q: string, a: string) => ({ question: q, answer: a, workspace_id: W1 });

  it("asks for the workspace's rows AND the shared ones", async () => {
    const { sb, calls } = stub(() => ({ data: [], error: null }));
    await loadWorkspaceFaqs(sb, W1);
    // Not "a filter was applied" — the actual filter, naming both tiers.
    expect(calls.filters.join(" ")).toMatch(new RegExp(`workspace_id\\.eq\\.${W1}`));
    expect(calls.filters.join(" ")).toMatch(/workspace_id\.is\.null/);
  });

  it("uses a shared answer when the workspace has none of its own", async () => {
    const { sb } = stub(() => ({
      data: [shared("Are you insured?", "Yes, fully licensed and insured.")], error: null,
    }));
    const out = await loadWorkspaceFaqs(sb, W1);
    expect(out.map((f) => f.answer)).toEqual(["Yes, fully licensed and insured."]);
  });

  it("lets the workspace's own answer beat the shared one", async () => {
    // The override is a ROW, not a deletion — the shared default stays intact
    // for every other workspace.
    const { sb } = stub(() => ({
      data: [
        local("What is your warranty?", "Three years here."),
        shared("what is your warranty?", "Two years."),
      ],
      error: null,
    }));
    const out = await loadWorkspaceFaqs(sb, W1);
    expect(out).toHaveLength(1);
    expect(out[0].answer).toBe("Three years here.");
  });

  it("matches an override regardless of case and spacing", async () => {
    const { sb } = stub(() => ({
      data: [local("  ARE YOU INSURED? ", "Local answer."), shared("are you insured?", "Shared.")],
      error: null,
    }));
    const out = await loadWorkspaceFaqs(sb, W1);
    expect(out.map((f) => f.answer)).toEqual(["Local answer."]);
  });

  it("drops a location-bound row that reached the shared tier anyway", async () => {
    // Save time refuses these. This is the read-time half: the table is what a
    // person edits, and SQL is a door the editor does not control.
    const { sb } = stub(() => ({
      data: [
        shared("Where are you located?", "Pasadena."),
        shared("Are you insured?", "Yes, fully licensed and insured."),
      ],
      error: null,
    }));
    const out = await loadWorkspaceFaqs(sb, W1);
    expect(out.map((f) => f.question)).toEqual(["Are you insured?"]);
  });

  it("still allows that same question when the WORKSPACE owns it", async () => {
    const { sb } = stub(() => ({
      data: [local("Where are you located?", "Pasadena.")], error: null,
    }));
    const out = await loadWorkspaceFaqs(sb, W1);
    expect(out.map((f) => f.answer)).toEqual(["Pasadena."]);
  });
});

/**
 * THE DIRECTION OF THE FAILURE IS THE POINT.
 *
 * Everywhere else in this system a read that fails stops the send. Here it
 * must not: a standing answer is additive, so without one the bot behaves as
 * it did yesterday and escalates. A throw on this path instead means the
 * customer gets no reply at all — a conversation lost to a missing
 * nice-to-have.
 */
describe("when the read fails", () => {
  const missing = { message: "Could not find the table 'public.sms_workspace_faqs' in the schema cache" };

  it("does not throw when the table is not there yet", async () => {
    // The deploy window: this code and its migration cannot land in the same
    // instant, and the messaging cron runs every minute.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb } = stub(() => ({ data: null, error: missing }));
    await expect(loadWorkspaceFaqs(sb, W1)).resolves.toEqual([]);
    // LOUDLY. A quiet catch here is the "silent nothing" shape.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/20260927100000_workspace_faqs\.sql/);
  });

  it("says so at error level when it is not just a missing table", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sb } = stub(() => ({ data: null, error: { message: "connection reset" } }));
    await expect(loadWorkspaceFaqs(sb, W1)).resolves.toEqual([]);
    expect(err).toHaveBeenCalled();
  });

  it("does NOT cache the failure — the next turn tries again", async () => {
    // Caching it would stretch one transient error into five minutes of a
    // workspace silently having no standing answers.
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const { sb, calls } = stub(() =>
      fail ? { data: null, error: { message: "connection reset" } } : { data: [rows[0]], error: null });
    expect(await loadWorkspaceFaqs(sb, W1)).toEqual([]);
    fail = false;
    expect(await loadWorkspaceFaqs(sb, W1)).toHaveLength(1);
    expect(calls.reads).toBe(2);
  });
});

/**
 * ── WHAT THE AUDITS FOUND ───────────────────────────────────────────────
 *
 * Three reviews of the shared tier agreed on these. Each is a case where
 * nothing errors, the screen looks right, and a customer gets the wrong
 * thing — the shape this codebase keeps producing.
 */
describe("the shared tier's sharp edges", () => {
  const shared = (q: string, a: string) => ({ question: q, answer: a, workspace_id: null });
  const local = (q: string, a: string) => ({ question: q, answer: a, workspace_id: W1 });

  it("refuses a workspace id that is not a UUID, and says so", async () => {
    // It goes into a PostgREST `.or()` filter STRING, where a comma starts
    // another condition: `<uuid>,workspace_id.not.is.null` matches the whole
    // table. Rejected on shape, not escaped.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sb, calls } = stub(() => ({ data: [shared("Q", "A")], error: null }));
    await expect(
      loadWorkspaceFaqs(sb, `${W1},workspace_id.not.is.null`)
    ).resolves.toEqual([]);
    expect(calls.reads, "nothing should have been read").toBe(0);
    expect(err).toHaveBeenCalled();
  });

  it("does not let an invalid LOCAL row evict a valid SHARED one", async () => {
    /**
     * Deduping before validating loses the answer entirely: the local row
     * wins the question, then checkFaq drops it for naming a price, and the
     * good shared answer that was already loaded is gone with it. The
     * workspace ends up with neither, for a question somebody wrote an
     * answer to.
     */
    const { sb } = stub(() => ({
      data: [
        local("What does the warranty cover?", "About $3,000 depending on scope."),
        shared("What does the warranty cover?", "Two years on labor."),
      ],
      error: null,
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await loadWorkspaceFaqs(sb, W1);
    expect(out.map((f) => f.answer)).toEqual(["Two years on labor."]);
  });

  it("says out loud when it drops a row on the way to the prompt", async () => {
    // This used to discard `rejected` into nothing, so a shared answer could
    // vanish from all 32 workspaces with no thread to pull.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sb } = stub(() => ({ data: [shared("how much", "About $2,500.")], error: null }));
    await loadWorkspaceFaqs(sb, W1);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toMatch(/SHARED/);
  });

  it("treats two questions differing only by inner spacing as one", async () => {
    // The unique index sees them as different strings, so the database allows
    // both; a match that only trimmed would put both in the prompt.
    const { sb } = stub(() => ({
      data: [local("Are  you   insured?", "Local."), shared("Are you insured?", "Shared.")],
      error: null,
    }));
    const out = await loadWorkspaceFaqs(sb, W1);
    expect(out.map((f) => f.answer)).toEqual(["Local."]);
  });

  it("orders the prompt by sort_order across BOTH tiers", async () => {
    // Building the map local-then-shared had quietly redefined sort_order as
    // "every local row, then every shared one".
    const { sb } = stub(() => ({
      data: [
        { ...local("Local later", "L"), sort_order: 9 },
        { ...shared("Shared first", "S"), sort_order: 1 },
      ],
      error: null,
    }));
    const out = await loadWorkspaceFaqs(sb, W1);
    expect(out.map((f) => f.question)).toEqual(["Shared first", "Local later"]);
  });
});

describe("the sandbox's default state", () => {
  it("loads the shared tier when no workspace is chosen", async () => {
    /**
     * "Default settings" is the Answer-as dropdown's first and default
     * option, and it used to load NOTHING — so the sandbox showed a bot that
     * escalates "Are you insured?" while production answers it. That screen
     * is where replies are graded, and a reply graded "Good" becomes an
     * example the next model imitates.
     */
    const { sb, calls } = stub(() => ({
      data: [{ question: "Are you insured?", answer: "Yes, fully licensed and insured.", sort_order: 0 }],
      error: null,
    }));
    const out = await loadSharedFaqs(sb);
    expect(calls.reads).toBe(1);
    expect(out.map((f) => f.question)).toEqual(["Are you insured?"]);
    expect(out[0].shared).toBe(true);
  });

  it("caches under a key no workspace can collide with", async () => {
    const { sb, calls } = stub(() => ({ data: [], error: null }));
    await loadSharedFaqs(sb);
    await loadWorkspaceFaqs(sb, W1);
    // Two different reads, not one served from the other's cache entry.
    expect(calls.reads).toBe(2);
  });
});
