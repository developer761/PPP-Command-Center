/**
 * Loading the standing answers, and what happens when that read fails.
 *
 * This loader sits on the per-turn hot path, which makes its failure mode a
 * question about the customer's reply and not about the knowledge base.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaceFaqs, clearWorkspaceFaqCache } from "@/lib/messaging/workspace-faq-db";

/** A client whose range() answers however the test says, counting its reads. */
function stub(answer: () => { data: unknown[] | null; error: { message: string } | null }) {
  const calls = { reads: 0 };
  const api: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "order"]) api[m] = () => api;
  api.range = async () => { calls.reads++; return answer(); };
  return { sb: api as unknown as SupabaseClient, calls };
}

const rows = [
  { question: "Are you insured?", answer: "Yes, we are fully licensed and insured." },
  { question: "how much", answer: "About $2,500." },
];

beforeEach(() => clearWorkspaceFaqCache());
afterEach(() => vi.restoreAllMocks());

describe("reading them", () => {
  it("returns the active rows, and drops an unsafe one on the way out", () => {
    // The check runs at READ time as well as at save time: the table is what a
    // person edits, so a save-time check is advice until something enforces it
    // on the way to the prompt.
    const { sb } = stub(() => ({ data: rows, error: null }));
    return loadWorkspaceFaqs(sb, "w1").then((out) => {
      expect(out.map((f) => f.question)).toEqual(["Are you insured?"]);
    });
  });

  it("reads once per workspace, then serves the cache", async () => {
    const { sb, calls } = stub(() => ({ data: [rows[0]], error: null }));
    await loadWorkspaceFaqs(sb, "w1");
    await loadWorkspaceFaqs(sb, "w1");
    expect(calls.reads).toBe(1);
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
    await expect(loadWorkspaceFaqs(sb, "w1")).resolves.toEqual([]);
    // LOUDLY. A quiet catch here is the "silent nothing" shape.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/20260927100000_workspace_faqs\.sql/);
  });

  it("says so at error level when it is not just a missing table", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sb } = stub(() => ({ data: null, error: { message: "connection reset" } }));
    await expect(loadWorkspaceFaqs(sb, "w1")).resolves.toEqual([]);
    expect(err).toHaveBeenCalled();
  });

  it("does NOT cache the failure — the next turn tries again", async () => {
    // Caching it would stretch one transient error into five minutes of a
    // workspace silently having no standing answers.
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const { sb, calls } = stub(() =>
      fail ? { data: null, error: { message: "connection reset" } } : { data: [rows[0]], error: null });
    expect(await loadWorkspaceFaqs(sb, "w1")).toEqual([]);
    fail = false;
    expect(await loadWorkspaceFaqs(sb, "w1")).toHaveLength(1);
    expect(calls.reads).toBe(2);
  });
});
